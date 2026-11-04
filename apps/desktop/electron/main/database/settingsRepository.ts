import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SETTINGS, isSettingKey, isValidSetting, type AppSettings } from '@animated-walls/shared-types';
import type { Logger } from '../logging/logger';

export class SettingsRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly logger: Logger,
  ) {}

  /** Stored values over defaults. Unreadable values fall back to the default and are logged. */
  getAll(): AppSettings {
    const settings = { ...DEFAULT_SETTINGS } as Record<keyof AppSettings, unknown>;
    const rows = this.db.prepare('SELECT key, value_json FROM settings').all() as unknown as { key: string; value_json: string }[];

    for (const row of rows) {
      if (!isSettingKey(row.key)) {
        this.logger.warn('app.settings', 'settings.unknown-key', { key: row.key });
        continue;
      }
      try {
        const value: unknown = JSON.parse(row.value_json);
        if (isValidSetting(row.key, value)) {
          settings[row.key] = value;
        } else {
          this.logger.warn('app.settings', 'settings.invalid-value', { key: row.key });
        }
      } catch (error) {
        this.logger.warn('app.settings', 'settings.unreadable-value', { key: row.key, error });
      }
    }
    return settings as AppSettings;
  }

  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): AppSettings {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
    return this.getAll();
  }
}
