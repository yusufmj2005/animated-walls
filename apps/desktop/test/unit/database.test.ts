import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@animated-walls/shared-types';
import { loadMigrations, openDatabase } from '../../electron/main/database/database';
import { MigrationError, migrate, parseMigrationFiles } from '../../electron/main/database/migrator';
import { SettingsRepository } from '../../electron/main/database/settingsRepository';
import { WallpaperRepository, type WallpaperRow } from '../../electron/main/database/wallpaperRepository';
import { quietLogger, tempDirectory } from './helpers';

function row(overrides: Partial<WallpaperRow> = {}): WallpaperRow {
  const id = overrides.id ?? '00000000-0000-0000-0000-000000000001';
  return {
    id,
    manifest_id: overrides.manifest_id ?? `manifest.${id}`,
    name: 'Aurora',
    description: null,
    creator_name: 'Studio',
    creator_url: null,
    type: 'web',
    entry_path: 'index.html',
    preview_path: 'preview.png',
    width: 1920,
    height: 1080,
    has_audio: 0,
    interactive: 0,
    source: 'package',
    format_version: 1,
    size_bytes: 100,
    required_capabilities: '[]',
    manifest_json: '{}',
    imported_at: '2026-01-01T00:00:00.000Z',
    last_used_at: null,
    ...overrides,
  };
}

describe('migrations', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
  });
  afterEach(() => db.close());

  const one = { version: 1, name: 'one', sql: 'CREATE TABLE a (x INTEGER) STRICT' };
  const two = { version: 2, name: 'two', sql: 'CREATE TABLE b (x INTEGER) STRICT' };

  it('applies pending migrations in order and records them', () => {
    expect(migrate(db, [one, two])).toEqual({ from: 0, to: 2, applied: ['one', 'two'] });
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 2 });
  });

  it('is a no-op when already up to date', () => {
    migrate(db, [one, two]);
    expect(migrate(db, [one, two])).toEqual({ from: 2, to: 2, applied: [] });
  });

  it('applies only the new migration on upgrade', () => {
    migrate(db, [one]);
    expect(migrate(db, [one, two]).applied).toEqual(['two']);
  });

  it('rolls back a failed migration and leaves the database at the last good version', () => {
    migrate(db, [one]);
    const bad = { version: 2, name: 'bad', sql: 'CREATE TABLE c (x INTEGER); THIS IS NOT SQL' };
    expect(() => migrate(db, [one, bad])).toThrow(MigrationError);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'c'").get()).toBeUndefined();
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 1 });
  });

  it('refuses an applied migration that was edited', () => {
    migrate(db, [one]);
    expect(() => migrate(db, [{ ...one, sql: 'CREATE TABLE a (y INTEGER) STRICT' }])).toThrow(/changed after it was applied/);
  });

  it('does not treat a line-ending change as an edit', () => {
    migrate(db, [{ ...one, sql: 'CREATE TABLE a\n(x INTEGER) STRICT' }]);
    expect(() => migrate(db, [{ ...one, sql: 'CREATE TABLE a\r\n(x INTEGER) STRICT' }])).not.toThrow();
  });

  it('refuses a database from a newer version of the app', () => {
    migrate(db, [one, two]);
    expect(() => migrate(db, [one])).toThrow(/newer version/);
  });

  it('rejects numbering gaps and bad file names', () => {
    expect(() => parseMigrationFiles({ 'a/001_a.sql': '', 'a/003_c.sql': '' })).toThrow(/without gaps/);
    expect(() => parseMigrationFiles({ 'a/nope.sql': '' })).toThrow(/not valid/);
  });

  it('the shipped schema matches database/schema/schema.sql', () => {
    const { db: shipped } = openDatabase(':memory:');
    const objects = shipped
      .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY type DESC, name")
      .all() as unknown as { sql: string }[];
    shipped.close();
    const actual = `${objects.map((item) => `${item.sql};`).join('\n\n')}\n`;
    const snapshot = resolve(import.meta.dirname, '../../../../database/schema/schema.sql');
    expect(actual.replace(/\r\n/g, '\n')).toBe(readFileSync(snapshot, 'utf8').replace(/\r\n/g, '\n'));
  });

  it('has at least the initial migration', () => {
    expect(loadMigrations().length).toBeGreaterThanOrEqual(1);
  });
});

describe('persistence across restarts', () => {
  it('keeps settings, wallpapers and assignments when reopened', () => {
    const directory = tempDirectory();
    const logger = quietLogger(directory.path);
    const path = join(directory.path, 'app.db');
    try {
      const first = openDatabase(path);
      new SettingsRepository(first.db, logger).set('frameRateLimit', 30);
      const wallpapers = new WallpaperRepository(first.db);
      wallpapers.insert(row());
      wallpapers.assign('display-1', row().id);
      first.db.close();

      const second = openDatabase(path);
      expect(second.migration.applied).toEqual([]);
      expect(new SettingsRepository(second.db, logger).getAll().frameRateLimit).toBe(30);
      const reopened = new WallpaperRepository(second.db);
      expect(reopened.find(row().id)?.name).toBe('Aurora');
      expect(reopened.listAssignments()[0]?.displayId).toBe('display-1');
      second.db.close();
    } finally {
      logger.close();
      directory.cleanup();
    }
  });

  it('refuses to open a corrupt database rather than replacing it', () => {
    const directory = tempDirectory();
    const path = join(directory.path, 'bad.db');
    try {
      writeFileSync(path, Buffer.alloc(8192, 0x41));
      expect(() => openDatabase(path)).toThrow();
      expect(readFileSync(path).length).toBe(8192);
    } finally {
      directory.cleanup();
    }
  });
});

describe('SettingsRepository', () => {
  let db: DatabaseSync;
  let directory: ReturnType<typeof tempDirectory>;
  let logger: ReturnType<typeof quietLogger>;
  let settings: SettingsRepository;

  beforeEach(() => {
    db = openDatabase(':memory:').db;
    directory = tempDirectory();
    logger = quietLogger(directory.path);
    settings = new SettingsRepository(db, logger);
  });
  afterEach(() => {
    db.close();
    logger.close();
    directory.cleanup();
  });

  it('returns defaults when nothing is stored', () => {
    expect(settings.getAll()).toEqual(DEFAULT_SETTINGS);
  });

  it('stores and overwrites a value', () => {
    settings.set('closeToTray', false);
    expect(settings.set('closeToTray', true).closeToTray).toBe(true);
  });

  it.each([
    ['frameRateLimit', '77'],
    ['closeToTray', '"yes"'],
    ['logLevel', '"loud"'],
    ['renderQuality', '{not json'],
  ])('falls back to the default for a bad stored %s', (key, value) => {
    db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)').run(key, value, 'now');
    expect(settings.getAll()).toEqual(DEFAULT_SETTINGS);
  });

  it('ignores unknown keys', () => {
    db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)').run('gone', '1', 'now');
    expect(settings.getAll()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('WallpaperRepository', () => {
  let db: DatabaseSync;
  let wallpapers: WallpaperRepository;

  beforeEach(() => {
    db = openDatabase(':memory:').db;
    wallpapers = new WallpaperRepository(db);
    wallpapers.insert(row({ id: 'a', name: 'Aurora', type: 'web', imported_at: '2026-01-01' }));
    wallpapers.insert(row({ id: 'b', name: 'beach', type: 'video', creator_name: 'Sea Co', imported_at: '2026-01-02' }));
    wallpapers.insert(row({ id: 'c', name: '100% Red_Sky', type: 'image', imported_at: '2026-01-03' }));
  });
  afterEach(() => db.close());

  const names = (rows: WallpaperRow[]) => rows.map((item) => item.name);

  it('sorts by recency by default, and by name without regard to case', () => {
    expect(names(wallpapers.list())).toEqual(['100% Red_Sky', 'beach', 'Aurora']);
    expect(names(wallpapers.list({ sort: 'name' }))).toEqual(['100% Red_Sky', 'Aurora', 'beach']);
  });

  it('filters by type', () => {
    expect(names(wallpapers.list({ type: 'video' }))).toEqual(['beach']);
    expect(wallpapers.list({ type: 'all' })).toHaveLength(3);
  });

  it('searches names and creators', () => {
    expect(names(wallpapers.list({ search: 'AUR' }))).toEqual(['Aurora']);
    expect(names(wallpapers.list({ search: 'sea co' }))).toEqual(['beach']);
  });

  it('treats search wildcards as literal text', () => {
    expect(names(wallpapers.list({ search: '%' }))).toEqual(['100% Red_Sky']);
    expect(names(wallpapers.list({ search: '_' }))).toEqual(['100% Red_Sky']);
  });

  it('is not injectable through search', () => {
    wallpapers.list({ search: "'; DROP TABLE wallpapers; --" });
    expect(wallpapers.list()).toHaveLength(3);
  });

  it('rejects two wallpapers with one manifest id', () => {
    expect(() => wallpapers.insert(row({ id: 'd', manifest_id: 'manifest.a' }))).toThrow();
  });

  it('marks a wallpaper used when assigned, and sorts by that', () => {
    wallpapers.assign('display', 'a');
    expect(wallpapers.find('a')?.last_used_at).not.toBeNull();
    expect(names(wallpapers.list({ sort: 'used' }))[0]).toBe('Aurora');
  });

  it('replaces an existing assignment for a display', () => {
    wallpapers.assign('display', 'a');
    wallpapers.assign('display', 'b');
    expect(wallpapers.listAssignments()).toHaveLength(1);
    expect(wallpapers.listAssignments()[0]?.wallpaperId).toBe('b');
  });

  it('removes assignments when their wallpaper is deleted', () => {
    wallpapers.assign('display', 'a');
    expect(wallpapers.delete('a')).toBe(true);
    expect(wallpapers.listAssignments()).toEqual([]);
  });

  it('rejects an assignment to a wallpaper that does not exist', () => {
    expect(() => wallpapers.assign('display', 'missing')).toThrow();
  });

  it('reports when there was nothing to delete', () => {
    expect(wallpapers.delete('missing')).toBe(false);
  });
});
