import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Logger } from '../../electron/main/logging/logger';
import { tempDirectory } from './helpers';

describe('Logger', () => {
  let directory: ReturnType<typeof tempDirectory>;

  beforeEach(() => {
    directory = tempDirectory();
  });
  afterEach(() => directory.cleanup());

  const lines = (name = 'app.log') => readFileSync(join(directory.path, name), 'utf8').trim().split('\n');

  it('writes one JSON object per line', () => {
    const logger = new Logger({ directory: directory.path });
    logger.info('src', 'first', { a: 1 });
    logger.warn('src', 'second');
    logger.close();

    const [first, second] = lines().map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(first).toMatchObject({ level: 'info', source: 'src', event: 'first', data: { a: 1 } });
    expect(second).toMatchObject({ level: 'warn', event: 'second' });
    expect(Date.parse(first?.['ts'] as string)).not.toBeNaN();
  });

  it('drops lines below the level and follows level changes', () => {
    const logger = new Logger({ directory: directory.path, level: 'warn' });
    logger.info('s', 'dropped');
    logger.setLevel('debug');
    logger.debug('s', 'kept');
    logger.close();
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain('kept');
  });

  it('serialises errors usefully', () => {
    const logger = new Logger({ directory: directory.path });
    logger.error('s', 'failed', { error: new TypeError('boom') });
    logger.close();
    expect(JSON.parse(lines()[0] ?? '{}')).toMatchObject({ data: { error: { name: 'TypeError', message: 'boom' } } });
  });

  it('rotates files and keeps a bounded number', () => {
    const logger = new Logger({ directory: directory.path, maxFileBytes: 400, maxFiles: 3 });
    for (let index = 0; index < 100; index += 1) logger.info('s', 'event', { index });
    logger.close();

    expect(readdirSync(directory.path).sort()).toEqual(['app.log', 'app.log.1', 'app.log.2']);
    expect(lines().at(-1)).toContain('"index":99');
  });

  it('never throws on data that cannot be serialised', () => {
    const logger = new Logger({ directory: directory.path });
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => logger.info('s', 'circular', { circular })).not.toThrow();
    expect(() => logger.info('s', 'bigint', { value: 10n })).not.toThrow();
    logger.info('s', 'after');
    logger.close();
    expect(lines().at(-1)).toContain('after');
  });

  it('continues an existing file after a restart', () => {
    const first = new Logger({ directory: directory.path });
    first.info('s', 'one');
    first.close();
    const second = new Logger({ directory: directory.path });
    second.info('s', 'two');
    second.close();
    expect(lines()).toHaveLength(2);
  });
});
