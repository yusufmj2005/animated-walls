import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';
import { ENGINE_PROTOCOL_VERSION } from '@animated-walls/shared-types';

const MAX_FRAME_BYTES = 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class EngineRpcError extends Error {
  override name = 'EngineRpcError';
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

interface WireMessage {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
  event?: string;
  data?: unknown;
}

export interface EnginePipeClientEvents {
  event: [name: string, data: unknown];
  close: [reason: string];
}

/**
 * Client end of the engine's named pipe. Frames are a 4-byte little-endian length and
 * UTF-8 JSON. The HMAC handshake proves each side holds the session token; the token
 * itself never crosses the pipe.
 */
export class EnginePipeClient extends EventEmitter<EnginePipeClientEvents> {
  private socket: Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly pipeName: string,
    private readonly token: string,
  ) {
    super();
  }

  async connect(): Promise<void> {
    const socket = await new Promise<Socket>((done, fail) => {
      const connection = connect(`\\\\.\\pipe\\${this.pipeName}`);
      connection.once('connect', () => {
        connection.removeListener('error', fail);
        done(connection);
      });
      connection.once('error', fail);
    });

    this.socket = socket;
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (error) => this.teardown(`pipe error: ${error.message}`));
    socket.on('close', () => this.teardown('pipe closed'));

    await this.handshake();
  }

  private async handshake(): Promise<void> {
    const clientNonce = randomBytes(32).toString('base64');
    const hello = (await this.request('session.hello', { clientNonce, protocolVersion: ENGINE_PROTOCOL_VERSION }, HANDSHAKE_TIMEOUT_MS)) as {
      serverNonce: string;
      serverProof: string;
    };

    if (!this.proofMatches(hello.serverProof, this.proof('server:', clientNonce))) {
      this.close();
      throw new Error('The engine failed to prove its identity, so the connection was refused.');
    }

    await this.request('session.authenticate', { clientProof: this.proof('client:', hello.serverNonce) }, HANDSHAKE_TIMEOUT_MS);
  }

  private proof(role: string, nonce: string): string {
    return createHmac('sha256', Buffer.from(this.token, 'utf8')).update(role + nonce).digest('base64');
  }

  private proofMatches(actual: string, expected: string): boolean {
    const a = Buffer.from(actual ?? '', 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  request(method: string, params?: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error('The engine is not connected.'));

    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ id, method, params }), 'utf8');
    if (payload.length > MAX_FRAME_BYTES) return Promise.reject(new Error(`The ${method} request is too large.`));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The engine did not answer ${method} within ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });

      const header = Buffer.alloc(4);
      header.writeInt32LE(payload.length, 0);
      socket.write(Buffer.concat([header, payload]));
    });
  }

  close(): void {
    this.socket?.destroy();
    this.teardown('closed by the app');
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 4) {
      const length = this.buffer.readInt32LE(0);
      if (length <= 0 || length > MAX_FRAME_BYTES) {
        this.socket?.destroy();
        this.teardown(`invalid frame length ${length}`);
        return;
      }
      if (this.buffer.length < 4 + length) return;

      const frame = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      this.onFrame(frame);
    }
  }

  private onFrame(frame: Buffer): void {
    let message: WireMessage;
    try {
      message = JSON.parse(frame.toString('utf8')) as WireMessage;
    } catch (error) {
      this.socket?.destroy();
      this.teardown(`invalid JSON from the engine: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    if (typeof message.event === 'string') {
      this.emit('event', message.event, message.data);
      return;
    }
    if (typeof message.id !== 'number') return;

    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.error) pending.reject(new EngineRpcError(message.error.message, message.error.code));
    else pending.resolve(message.result);
  }

  private teardown(reason: string): void {
    if (!this.socket) return;
    this.socket = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`The engine connection ended during ${pending.method}: ${reason}`));
    }
    this.pending.clear();
    this.emit('close', reason);
  }
}
