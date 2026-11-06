import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, existsSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { LogLevel } from '@animated-walls/shared-types';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LoggerOptions {
  directory: string;
  fileName?: string;
  level?: LogLevel;
  maxFileBytes?: number;
  maxFiles?: number;
}

export type LogData = Record<string, unknown>;

/**
 * Structured JSON-lines logger, in the same format as the engine's so both files can be
 * read together. A logging failure never takes the app down, but the first one is
 * reported on stderr rather than disappearing.
 */
export class Logger {
  private readonly path: string;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private level: LogLevel;
  private fd: number | null = null;
  private size = 0;
  private reportedFailure = false;
  private closed = false;

  constructor(options: LoggerOptions) {
    this.path = join(options.directory, options.fileName ?? 'app.log');
    this.level = options.level ?? 'info';
    this.maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 5;
    try {
      mkdirSync(options.directory, { recursive: true });
      this.open();
    } catch (error) {
      this.reportFailure('open', error);
    }
  }

  get filePath(): string {
    return this.path;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(source: string, event: string, data?: LogData): void {
    this.write('debug', source, event, data);
  }
  info(source: string, event: string, data?: LogData): void {
    this.write('info', source, event, data);
  }
  warn(source: string, event: string, data?: LogData): void {
    this.write('warn', source, event, data);
  }
  error(source: string, event: string, data?: LogData): void {
    this.write('error', source, event, data);
  }

  close(): void {
    this.closed = true;
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch (error) {
      this.reportFailure('close', error);
    }
    this.fd = null;
  }

  private open(): void {
    this.fd = openSync(this.path, 'a');
    this.size = statSync(this.path).size;
  }

  private write(level: LogLevel, source: string, event: string, data?: LogData): void {
    if (this.closed || LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    try {
      // Reopens after an earlier failure, so one bad moment does not end logging.
      if (this.fd === null) this.open();
      const bytes = Buffer.from(formatLine(level, source, event, data), 'utf8');
      this.rotateIfNeeded(bytes.length);
      if (this.fd === null) return;
      writeSync(this.fd, bytes);
      this.size += bytes.length;
    } catch (error) {
      this.reportFailure('write', error);
    }
  }

  private rotateIfNeeded(incoming: number): void {
    if (this.size + incoming <= this.maxFileBytes || this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
    try {
      rmSync(`${this.path}.${this.maxFiles - 1}`, { force: true });
      for (let index = this.maxFiles - 2; index >= 1; index -= 1) {
        const from = `${this.path}.${index}`;
        if (existsSync(from)) renameSync(from, `${this.path}.${index + 1}`);
      }
      renameSync(this.path, `${this.path}.1`);
    } catch (error) {
      // Another program can hold a log file open. Keep logging to the same file, since
      // an oversized file beats lost lines, and rotation is retried on the next write.
      this.reportFailure('rotate', error);
    }
    this.open();
  }

  private reportFailure(operation: string, error: unknown): void {
    if (this.reportedFailure) return;
    this.reportedFailure = true;
    console.error(`[logger] ${operation} failed:`, error);
  }
}

function formatLine(level: LogLevel, source: string, event: string, data: LogData | undefined): string {
  const entry = { ts: new Date().toISOString(), level, source, event };
  try {
    return `${JSON.stringify({ ...entry, data: normalise(data) })}\n`;
  } catch (error) {
    // Circular values and BigInts cannot be written. Logging must never throw at its caller,
    // so the event is kept without its data.
    return `${JSON.stringify({ ...entry, dataError: error instanceof Error ? error.message : String(error) })}\n`;
  }
}

function normalise(data: LogData | undefined): LogData | undefined {
  if (!data) return undefined;
  const result: LogData = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;
  }
  return result;
}
