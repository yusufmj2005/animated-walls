import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { EngineEvents, EngineHealth, EngineMethods, EngineState, EngineStatus, LogLevel } from '@animated-walls/shared-types';
import type { Logger } from '../logging/logger';
import { EnginePipeClient } from './enginePipeClient';

const LOG_SOURCE = 'app.engine';
const READY_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;
const DEFAULT_HEALTH_INTERVAL_MS = 15_000;
const HEALTH_TIMEOUT_MS = 5_000;
const MAX_MISSED_HEALTH_CHECKS = 2;
const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** Stable this long, and a later crash starts from the first backoff step again. */
const STABLE_AFTER_MS = 5 * 60_000;

export interface SupervisorOptions {
  enginePath: string;
  logDirectory: string;
  logLevel: LogLevel;
  logger: Logger;
  healthIntervalMs?: number;
  /** Runs after every successful connection, to restore assignments and configuration. */
  onConnected?: (supervisor: EngineSupervisor) => Promise<void>;
}

export interface SupervisorEvents {
  status: [status: EngineStatus];
  state: [state: EngineState];
}

type Params<M extends keyof EngineMethods> = EngineMethods[M]['params'];
type Result<M extends keyof EngineMethods> = EngineMethods[M]['result'];

/**
 * Runs the engine as a child process: spawning, connecting, health checks, restarting
 * after crashes, and clean shutdown. The engine is a separate process so a native crash
 * cannot take the UI down, and so wallpapers can keep running with the UI closed.
 */
export class EngineSupervisor extends EventEmitter<SupervisorEvents> {
  private process: ChildProcessWithoutNullStreams | null = null;
  private client: EnginePipeClient | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private missedHealthChecks = 0;
  private restartAttempts = 0;
  private connectedAt = 0;
  private stopping = false;
  private lastState: EngineState | null = null;
  private currentStatus: EngineStatus = { connection: 'stopped', health: null, lastError: null, restarts: 0 };

  constructor(private readonly options: SupervisorOptions) {
    super();
  }

  get status(): EngineStatus {
    return this.currentStatus;
  }

  get state(): EngineState | null {
    return this.lastState;
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.clearRestartTimer();
    this.restartAttempts = 0;
    await this.launch();
  }

  /** Sends a request to the engine. Rejects when it is not connected. */
  async call<M extends keyof EngineMethods>(method: M, ...args: Params<M> extends void ? [] : [Params<M>]): Promise<Result<M>> {
    if (!this.client) throw new Error('The engine is not connected.');
    return (await this.client.request(method, args[0])) as Result<M>;
  }

  async restart(): Promise<void> {
    this.options.logger.info(LOG_SOURCE, 'engine.restart-requested');
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearRestartTimer();
    this.stopHealthChecks();

    const child = this.process;
    const client = this.client;
    if (client) {
      try {
        await client.request('engine.shutdown', undefined, SHUTDOWN_TIMEOUT_MS);
      } catch (error) {
        this.options.logger.warn(LOG_SOURCE, 'engine.shutdown-request-failed', { error });
      }
    }
    if (child && child.exitCode === null) {
      const exited = await waitForExit(child, SHUTDOWN_TIMEOUT_MS);
      if (!exited) {
        this.options.logger.warn(LOG_SOURCE, 'engine.kill', { pid: child.pid });
        child.kill();
      }
    }
    client?.close();
    this.client = null;
    this.process = null;
    this.setStatus({ connection: 'stopped', health: null });
  }

  private async launch(): Promise<void> {
    const { enginePath, logDirectory, logLevel, logger } = this.options;
    this.setStatus({ connection: this.restartAttempts > 0 ? 'restarting' : 'starting', health: null });

    if (!existsSync(enginePath)) {
      this.fail(`The engine executable was not found at ${enginePath}. Run "npm run build:engine".`);
      return;
    }

    // Random per launch. Together with FirstPipeInstance on the engine side, another
    // process cannot get in front of it by claiming a known name.
    const pipeName = `animated-walls-${randomBytes(16).toString('hex')}`;
    const token = randomBytes(32).toString('base64');

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(enginePath, ['--pipe', pipeName, '--log-dir', logDirectory, '--log-level', logLevel], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      this.scheduleRestart(`The engine could not be started: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.process = child;
    logger.info(LOG_SOURCE, 'engine.spawned', { pid: child.pid });

    child.on('error', (error) => {
      logger.error(LOG_SOURCE, 'engine.process-error', { error });
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text: string) => {
      logger.warn(LOG_SOURCE, 'engine.stderr', { text: text.trim() });
    });
    child.stdin.on('error', (error) => {
      // The stdin pipe breaks when the engine exits, and the exit handler deals with that.
      logger.debug(LOG_SOURCE, 'engine.stdin-error', { message: error.message });
    });

    // The token goes over stdin, because any process can read another's command line.
    // Stdin then stays open for the engine's life: its closing tells the engine that
    // this process has died.
    child.stdin.write(`${token}\n`);

    const exitPromise = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    void exitPromise.then((code) => this.onExit(child, code));

    try {
      await waitForReady(child, READY_TIMEOUT_MS);
      await this.connect(pipeName, token);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(LOG_SOURCE, 'engine.start-failed', { message });
      if (child.exitCode === null) child.kill();
      // onExit runs next and schedules the restart with this as the reason.
      this.setStatus({ lastError: message });
    }
  }

  private async connect(pipeName: string, token: string): Promise<void> {
    const client = new EnginePipeClient(pipeName, token);
    client.on('event', (name, data) => {
      if (name === 'state.changed') {
        this.lastState = data as EngineEvents['state.changed'];
        this.emit('state', this.lastState);
      } else {
        this.options.logger.warn(LOG_SOURCE, 'engine.unknown-event', { name });
      }
    });
    client.on('close', (reason) => {
      this.options.logger.info(LOG_SOURCE, 'ipc.closed', { reason });
      if (this.client === client) this.client = null;
    });

    await client.connect();
    this.client = client;
    this.connectedAt = Date.now();
    this.options.logger.info(LOG_SOURCE, 'ipc.connected');

    await this.options.onConnected?.(this);
    this.lastState = await this.call('engine.state');
    this.emit('state', this.lastState);

    const health = await this.call('engine.health');
    this.setStatus({ connection: 'connected', health, lastError: null });
    this.startHealthChecks();
  }

  private startHealthChecks(): void {
    this.stopHealthChecks();
    this.missedHealthChecks = 0;
    this.healthTimer = setInterval(() => void this.checkHealth(), this.options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS);
    this.healthTimer.unref();
  }

  private stopHealthChecks(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  private async checkHealth(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const health = (await client.request('engine.health', undefined, HEALTH_TIMEOUT_MS)) as EngineHealth;
      this.missedHealthChecks = 0;
      this.setStatus({ health });
    } catch (error) {
      this.missedHealthChecks += 1;
      this.options.logger.warn(LOG_SOURCE, 'ipc.health-check-failed', { missed: this.missedHealthChecks, error });
      if (this.missedHealthChecks >= MAX_MISSED_HEALTH_CHECKS) {
        this.options.logger.error(LOG_SOURCE, 'engine.unresponsive', { pid: this.process?.pid });
        this.process?.kill();
      }
    }
  }

  private onExit(child: ChildProcessWithoutNullStreams, code: number | null): void {
    this.options.logger.info(LOG_SOURCE, 'engine.exited', { pid: child.pid, code });
    if (this.process !== child) return;

    this.process = null;
    this.stopHealthChecks();
    this.client?.close();
    this.client = null;
    this.lastState = null;

    if (this.stopping) return;
    this.scheduleRestart(this.currentStatus.lastError ?? `The engine stopped unexpectedly (exit code ${code ?? 'unknown'}).`);
  }

  private scheduleRestart(reason: string): void {
    if (this.connectedAt > 0 && Date.now() - this.connectedAt > STABLE_AFTER_MS) {
      this.restartAttempts = 0;
    }

    const delay = RESTART_BACKOFF_MS[this.restartAttempts];
    if (delay === undefined) {
      this.fail(`${reason} It kept failing after ${RESTART_BACKOFF_MS.length} restarts, so it will not restart automatically.`);
      return;
    }

    this.restartAttempts += 1;
    this.options.logger.warn(LOG_SOURCE, 'engine.restart-scheduled', { reason, delayMs: delay, attempt: this.restartAttempts });
    this.setStatus({ connection: 'restarting', health: null, lastError: reason, restarts: this.currentStatus.restarts + 1 });

    this.clearRestartTimer();
    this.restartTimer = setTimeout(() => void this.launch(), delay);
    this.restartTimer.unref();
  }

  private fail(message: string): void {
    this.options.logger.error(LOG_SOURCE, 'engine.failed', { message });
    this.setStatus({ connection: 'failed', health: null, lastError: message });
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private setStatus(update: Partial<EngineStatus>): void {
    this.currentStatus = { ...this.currentStatus, ...update };
    this.emit('status', this.currentStatus);
  }
}

function waitForReady(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      lines.close();
      if (error) reject(error);
      else resolve();
    };
    const onExit = (code: number | null): void => finish(new Error(`The engine exited during startup (exit code ${code ?? 'unknown'}).`));
    const timer = setTimeout(() => finish(new Error(`The engine did not become ready within ${timeoutMs} ms.`)), timeoutMs);

    child.once('exit', onExit);
    lines.on('line', (line) => {
      try {
        if ((JSON.parse(line) as { event?: string }).event === 'engine.ready') finish();
      } catch {
        // Only a machine-readable ready message counts. Anything else is not it.
      }
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}
