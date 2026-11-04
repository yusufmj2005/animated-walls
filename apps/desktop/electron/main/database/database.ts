import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate, parseMigrationFiles, type MigrationResult } from './migrator';

// Bundled at build time, so the packaged app cannot run against mismatched SQL files.
const migrationFiles = import.meta.glob('../../../../../database/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export function loadMigrations() {
  return parseMigrationFiles(migrationFiles);
}

export interface OpenedDatabase {
  db: DatabaseSync;
  migration: MigrationResult;
}

export function openDatabase(path: string): OpenedDatabase {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 2000');

    const check = db.prepare('PRAGMA quick_check(1)').get() as { quick_check: string };
    if (check.quick_check !== 'ok') {
      throw new Error(`The database failed its integrity check: ${check.quick_check}`);
    }

    return { db, migration: migrate(db, loadMigrations()) };
  } catch (error) {
    db.close();
    throw error;
  }
}
