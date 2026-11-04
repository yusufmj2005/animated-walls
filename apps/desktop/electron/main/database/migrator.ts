import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export class MigrationError extends Error {
  override name = 'MigrationError';
}

const MIGRATION_FILE = /(\d+)_([^/\\]+)\.sql$/;

/** Turns `{ path: sql }` from a bundler glob into ordered, validated migrations. */
export function parseMigrationFiles(files: Record<string, string>): Migration[] {
  const migrations = Object.entries(files).map(([path, sql]) => {
    const match = MIGRATION_FILE.exec(path);
    if (!match?.[1] || !match[2]) throw new MigrationError(`Migration file name is not valid: ${path}`);
    return { version: Number(match[1]), name: match[2], sql };
  });
  migrations.sort((a, b) => a.version - b.version);
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new MigrationError(`Migrations must be numbered without gaps; expected ${index + 1}, found ${migration.version}.`);
    }
  });
  return migrations;
}

function checksum(sql: string): string {
  // Normalise line endings so a Git checkout's EOL settings cannot change the checksum.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: string[];
}

/**
 * Applies pending migrations, each in its own transaction, so a failure leaves the
 * database at the last good version. An applied migration that has since been edited,
 * or a database from a newer app version, stops startup rather than risking user data.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[]): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);

  const applied = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as unknown as {
    version: number;
    name: string;
    checksum: string;
  }[];

  const known = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const row of applied) {
    const migration = known.get(row.version);
    if (!migration) {
      throw new MigrationError(`The database is at migration ${row.version} (${row.name}), which this version of the app does not know. It was probably created by a newer version.`);
    }
    if (checksum(migration.sql) !== row.checksum) {
      throw new MigrationError(`Migration ${row.version} (${row.name}) changed after it was applied. Applied migrations must never be edited.`);
    }
  }

  const from = applied.at(-1)?.version ?? 0;
  const appliedNames: string[] = [];
  const record = db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)');

  for (const migration of migrations) {
    if (migration.version <= from) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, checksum(migration.sql), new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new MigrationError(`Migration ${migration.version} (${migration.name}) failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    appliedNames.push(migration.name);
  }

  return { from, to: migrations.at(-1)?.version ?? from, applied: appliedNames };
}
