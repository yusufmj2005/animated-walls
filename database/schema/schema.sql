CREATE TABLE display_assignments (
  display_id   TEXT PRIMARY KEY,
  wallpaper_id TEXT NOT NULL REFERENCES wallpapers (id) ON DELETE CASCADE,
  updated_at   TEXT NOT NULL
) STRICT;

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE wallpapers (
  id                    TEXT PRIMARY KEY,
  manifest_id           TEXT NOT NULL UNIQUE,
  name                  TEXT NOT NULL,
  description           TEXT,
  creator_name          TEXT NOT NULL,
  creator_url           TEXT,
  type                  TEXT NOT NULL CHECK (type IN ('video', 'image', 'web')),
  entry_path            TEXT NOT NULL,
  preview_path          TEXT,
  width                 INTEGER NOT NULL,
  height                INTEGER NOT NULL,
  has_audio             INTEGER NOT NULL CHECK (has_audio IN (0, 1)),
  interactive           INTEGER NOT NULL CHECK (interactive IN (0, 1)),
  source                TEXT NOT NULL CHECK (source IN ('package', 'media-file')),
  format_version        INTEGER NOT NULL,
  size_bytes            INTEGER NOT NULL,
  required_capabilities TEXT NOT NULL DEFAULT '[]',
  manifest_json         TEXT NOT NULL,
  imported_at           TEXT NOT NULL,
  last_used_at          TEXT
) STRICT;

CREATE INDEX idx_wallpapers_imported ON wallpapers (imported_at);

CREATE INDEX idx_wallpapers_name ON wallpapers (name COLLATE NOCASE);
