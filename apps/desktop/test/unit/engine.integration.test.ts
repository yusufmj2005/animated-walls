import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineState } from '@animated-walls/shared-types';
import { EngineSupervisor } from '../../electron/main/engine/engineSupervisor';
import { EnginePipeClient, EngineRpcError } from '../../electron/main/engine/enginePipeClient';
import { quietLogger, tempDirectory } from './helpers';

// These run the real engine executable over the real named pipe.
const enginePath = [
  resolve(import.meta.dirname, '../../resources/engine/AnimatedWalls.Engine.exe'),
  resolve(import.meta.dirname, '../../../../engine/AnimatedWalls.Engine/bin/Debug/net10.0-windows/win-x64/AnimatedWalls.Engine.exe'),
].find((path) => existsSync(path));

function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  return new Promise((done, fail) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        done();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        fail(new Error('Timed out waiting for the condition.'));
      }
    }, 25);
  });
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!enginePath)('engine over named pipe', () => {
  let directory: ReturnType<typeof tempDirectory>;
  let logger: ReturnType<typeof quietLogger>;

  beforeEach(() => {
    directory = tempDirectory();
    logger = quietLogger(directory.path);
  });

  afterEach(() => {
    logger.close();
    directory.cleanup();
  });

  function spawnEngine() {
    const pipe = `animated-walls-test-${randomBytes(8).toString('hex')}`;
    const token = randomBytes(32).toString('base64');
    const child = spawn(enginePath!, ['--pipe', pipe, '--log-dir', directory.path], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stdin.write(`${token}\n`);
    const ready = new Promise<void>((done, fail) => {
      createInterface({ input: child.stdout }).once('line', () => done());
      child.once('exit', (code) => fail(new Error(`The engine exited with ${code}`)));
    });
    return { child, pipe, token, ready };
  }

  describe('supervisor', () => {
    let supervisor: EngineSupervisor;

    beforeEach(() => {
      supervisor = new EngineSupervisor({ enginePath: enginePath!, logDirectory: directory.path, logLevel: 'info', logger, healthIntervalMs: 200 });
    });
    afterEach(async () => {
      await supervisor.stop();
    });

    it('connects, reports health and receives real state', async () => {
      await supervisor.start();
      expect(supervisor.status.connection).toBe('connected');

      const health = await supervisor.call('engine.health');
      expect(health.protocolVersion).toBe(1);
      expect(health.rendererImplemented).toBe(false);
      expect(health.counters.framesPresented).toBe(0);

      const state = await supervisor.call('engine.state');
      expect(state.displays.length).toBeGreaterThan(0);
      expect(state.visibility).toHaveLength(state.displays.length);
    });

    it('reports GPU capability and never selects a software adapter', async () => {
      await supervisor.start();
      const gpu = await supervisor.call('engine.capabilities');
      expect(['supported', 'unsupported']).toContain(gpu.status);
      if (gpu.selectedAdapter) expect(gpu.selectedAdapter.isSoftware).toBe(false);
    });

    it('changes render decisions when assignments and pause change', async () => {
      await supervisor.start();
      const state = await supervisor.call('engine.state');
      const displayId = state.displays[0]!.id;
      expect(state.render[0]!.decision).toBe('idle');

      const events: EngineState[] = [];
      supervisor.on('state', (next) => events.push(next));

      const assigned = await supervisor.call('playback.setAssignments', { assignments: [{ displayId, wallpaperId: 'w1' }] });
      expect(assigned.render[0]!.wallpaperId).toBe('w1');
      expect(assigned.render[0]!.decision).not.toBe('idle');

      const paused = await supervisor.call('playback.setPaused', { paused: true });
      expect(paused.render[0]).toMatchObject({ decision: 'suspended', reason: 'user-paused' });

      await until(() => events.some((event) => event.paused));
    });

    it('rejects unknown methods and bad parameters as errors, without crashing', async () => {
      await supervisor.start();
      const call = supervisor.call.bind(supervisor) as unknown as (method: string, params?: unknown) => Promise<unknown>;
      await expect(call('nope.nothing')).rejects.toBeInstanceOf(EngineRpcError);
      await expect(call('playback.setPaused', { paused: 'yes' })).rejects.toBeInstanceOf(EngineRpcError);
      await expect(call('diagnostics.setLogLevel', { level: 'loud' })).rejects.toBeInstanceOf(EngineRpcError);
      expect((await supervisor.call('engine.health')).pid).toBeGreaterThan(0);
    });

    it('measures this process GPU use on request', async () => {
      await supervisor.start();
      const diagnostics = await supervisor.call('engine.diagnostics');
      expect(diagnostics.gpuUsage.available).toBe(true);
      expect(diagnostics.desktopHost.progmanFound).toBe(true);
      expect(diagnostics.logFile).toContain('engine.log');
    });

    it('stops cleanly and the process exits', async () => {
      await supervisor.start();
      const pid = (await supervisor.call('engine.health')).pid;
      await supervisor.stop();
      expect(supervisor.status.connection).toBe('stopped');
      await until(() => !isRunning(pid));
    });

    it('restarts the engine after it is killed', async () => {
      await supervisor.start();
      const pid = (await supervisor.call('engine.health')).pid;
      process.kill(pid);

      await until(() => supervisor.status.connection === 'restarting');
      await until(() => supervisor.status.connection === 'connected' && supervisor.status.health?.pid !== pid, 15_000);
      expect(supervisor.status.restarts).toBe(1);
      expect((await supervisor.call('engine.health')).pid).not.toBe(pid);
    });

    it('reports failure when the executable is missing', async () => {
      const missing = new EngineSupervisor({ enginePath: join(directory.path, 'nothing.exe'), logDirectory: directory.path, logLevel: 'info', logger });
      await missing.start();
      expect(missing.status.connection).toBe('failed');
      expect(missing.status.lastError).toMatch(/not found/);
    });

    it('writes structured engine logs', async () => {
      await supervisor.start();
      await supervisor.stop();
      const lines = readFileSync(join(directory.path, 'engine.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { event: string });
      const events = lines.map((line) => line.event);
      expect(events).toEqual(expect.arrayContaining(['engine.start', 'gpu.detected', 'client.authenticated', 'engine.exit']));
    });
  });

  describe('security', () => {
    it('exits when the parent closes stdin, so no engine is orphaned', async () => {
      const { child, ready } = spawnEngine();
      await ready;
      child.stdin.end();
      const code = await new Promise<number | null>((done) => child.once('exit', done));
      expect(code).toBe(0);
    });

    it('rejects a client with the wrong token, and accepts the right one afterwards', async () => {
      const { child, pipe, token, ready } = spawnEngine();
      await ready;
      try {
        const impostor = new EnginePipeClient(pipe, 'wrong-token');
        await expect(impostor.connect()).rejects.toThrow(/prove its identity/);

        await until(() => !child.killed, 1000);
        const client = new EnginePipeClient(pipe, token);
        await retryConnect(client);
        await expect(client.request('engine.health')).resolves.toMatchObject({ protocolVersion: 1 });
        client.close();
      } finally {
        child.kill();
      }
    });

    it('refuses any method before the handshake completes', async () => {
      const { child, pipe, ready } = spawnEngine();
      await ready;
      try {
        const reply = await rawExchange(pipe, { id: 1, method: 'engine.shutdown' });
        expect(reply).toBe('closed');
        expect(child.exitCode).toBeNull();
      } finally {
        child.kill();
      }
    });

    it('survives an absurd frame length without allocating it', async () => {
      const { child, pipe, ready } = spawnEngine();
      await ready;
      try {
        await new Promise<void>((done) => {
          const socket = connect(`\\\\.\\pipe\\${pipe}`);
          socket.once('connect', () => {
            const header = Buffer.alloc(4);
            header.writeInt32LE(0x7fffffff);
            socket.write(header);
          });
          socket.once('close', () => done());
          socket.on('error', () => done());
        });
        expect(child.exitCode).toBeNull();
      } finally {
        child.kill();
      }
    });

    it('keeps the token out of the command line and the logs', async () => {
      const { child, token, ready } = spawnEngine();
      await ready;
      expect(child.spawnargs.join(' ')).not.toContain(token);
      child.kill();
      await new Promise((done) => child.once('exit', done));
      expect(readFileSync(join(directory.path, 'engine.log'), 'utf8')).not.toContain(token);
    });
  });
});

async function retryConnect(client: EnginePipeClient): Promise<void> {
  // The single pipe instance becomes available again moments after a client is rejected.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await client.connect();
      return;
    } catch (error) {
      if (attempt >= 40) throw error;
      await new Promise((done) => setTimeout(done, 50));
    }
  }
}

function rawExchange(pipe: string, message: object): Promise<string> {
  return new Promise((done) => {
    const socket = connect(`\\\\.\\pipe\\${pipe}`);
    socket.once('connect', () => {
      const payload = Buffer.from(JSON.stringify(message));
      const header = Buffer.alloc(4);
      header.writeInt32LE(payload.length);
      socket.write(Buffer.concat([header, payload]));
    });
    socket.once('data', () => {
      socket.destroy();
      done('answered');
    });
    socket.once('close', () => done('closed'));
    socket.once('error', () => done('closed'));
  });
}
