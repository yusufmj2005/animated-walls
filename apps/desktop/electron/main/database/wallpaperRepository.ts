import type { DatabaseSync } from 'node:sqlite';
import type { DisplayAssignmentRecord, WallpaperKind, WallpaperQuery, WallpaperSource } from '@animated-walls/shared-types';

export interface WallpaperRow {
  id: string;
  manifest_id: string;
  name: string;
  description: string | null;
  creator_name: string;
  creator_url: string | null;
  type: WallpaperKind;
  entry_path: string;
  preview_path: string | null;
  width: number;
  height: number;
  has_audio: number;
  interactive: number;
  source: WallpaperSource;
  format_version: number;
  size_bytes: number;
  required_capabilities: string;
  manifest_json: string;
  imported_at: string;
  last_used_at: string | null;
}

const SORT_ORDER = {
  recent: 'imported_at DESC',
  name: 'name COLLATE NOCASE ASC',
  used: 'last_used_at IS NULL, last_used_at DESC, imported_at DESC',
} as const;

export class WallpaperRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(row: WallpaperRow): void {
    this.db
      .prepare(
        `INSERT INTO wallpapers (
           id, manifest_id, name, description, creator_name, creator_url, type, entry_path,
           preview_path, width, height, has_audio, interactive, source, format_version,
           size_bytes, required_capabilities, manifest_json, imported_at, last_used_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.manifest_id, row.name, row.description, row.creator_name, row.creator_url, row.type, row.entry_path,
        row.preview_path, row.width, row.height, row.has_audio, row.interactive, row.source, row.format_version,
        row.size_bytes, row.required_capabilities, row.manifest_json, row.imported_at, row.last_used_at,
      );
  }

  find(id: string): WallpaperRow | undefined {
    return this.db.prepare('SELECT * FROM wallpapers WHERE id = ?').get(id) as unknown as WallpaperRow | undefined;
  }

  findByManifestId(manifestId: string): WallpaperRow | undefined {
    return this.db.prepare('SELECT * FROM wallpapers WHERE manifest_id = ?').get(manifestId) as unknown as WallpaperRow | undefined;
  }

  list(query: WallpaperQuery = {}): WallpaperRow[] {
    const conditions: string[] = [];
    const parameters: string[] = [];

    const search = query.search?.trim();
    if (search) {
      conditions.push(`(name LIKE ? ESCAPE '\\' OR creator_name LIKE ? ESCAPE '\\')`);
      const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      parameters.push(pattern, pattern);
    }
    if (query.type && query.type !== 'all') {
      conditions.push('type = ?');
      parameters.push(query.type);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    // The sort key is read from a fixed table, never interpolated from the caller.
    const order = SORT_ORDER[query.sort ?? 'recent'];
    return this.db.prepare(`SELECT * FROM wallpapers ${where} ORDER BY ${order}`).all(...parameters) as unknown as WallpaperRow[];
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM wallpapers WHERE id = ?').run(id).changes > 0;
  }

  markUsed(id: string): void {
    this.db.prepare('UPDATE wallpapers SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  listAssignments(): DisplayAssignmentRecord[] {
    const rows = this.db.prepare('SELECT display_id, wallpaper_id, updated_at FROM display_assignments').all() as unknown as {
      display_id: string;
      wallpaper_id: string;
      updated_at: string;
    }[];
    return rows.map((row) => ({ displayId: row.display_id, wallpaperId: row.wallpaper_id, updatedAt: row.updated_at }));
  }

  assign(displayId: string, wallpaperId: string): void {
    this.db
      .prepare(
        `INSERT INTO display_assignments (display_id, wallpaper_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (display_id) DO UPDATE SET wallpaper_id = excluded.wallpaper_id, updated_at = excluded.updated_at`,
      )
      .run(displayId, wallpaperId, new Date().toISOString());
    this.markUsed(wallpaperId);
  }

  unassign(displayId: string): void {
    this.db.prepare('DELETE FROM display_assignments WHERE display_id = ?').run(displayId);
  }
}
