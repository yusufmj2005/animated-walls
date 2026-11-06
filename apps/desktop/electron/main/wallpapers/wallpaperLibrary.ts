import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve, sep, win32 } from 'node:path';
import type { ImportIssue, ImportResult, WallpaperRecord } from '@animated-walls/shared-types';
import {
  CURRENT_FORMAT_VERSION,
  DEFAULT_PACKAGE_LIMITS,
  IMAGE_HEADER_BYTES,
  PACKAGE_EXTENSION,
  SNIFF_BYTES,
  mediaKindFromPath,
  parseManifest,
  readImageSize,
  sniffMediaKind,
  stripUnsafeText,
  validatePackageListing,
  type MediaKind,
  type ValidationIssue,
  type WallpaperManifest,
} from '@animated-walls/wallpaper-format';
import type { WallpaperRepository, WallpaperRow } from '../database/wallpaperRepository';
import type { Logger } from '../logging/logger';
import { PackageReader, PackageReadError } from './packageReader';

const LOG_SOURCE = 'app.library';
const STAGING_DIRECTORY = '.staging';
const VIDEO_KINDS: readonly MediaKind[] = ['mp4', 'webm'];
const IMAGE_KINDS: readonly MediaKind[] = ['png', 'jpeg', 'webp'];
const REMOVAL_MARKER = '.removed';
const WALLPAPER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A video being previewed can hold its file open for a moment after it is unmounted.
const REMOVE_RETRIES = { maxRetries: 5, retryDelay: 100 };
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];
const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);

export const IMPORTABLE_EXTENSIONS = ['awall', 'mp4', 'webm', 'png', 'jpg', 'jpeg', 'webp'];

export const MEDIA_SCHEME = 'awall-media';

export type MediaAsset = 'preview' | 'entry';

export interface ResolvedMedia {
  path: string;
  kind: MediaKind;
}

export interface LibraryOptions {
  root: string;
  repository: WallpaperRepository;
  logger: Logger;
}

class ImportRejected extends Error {
  constructor(readonly issues: ImportIssue[]) {
    super(issues[0]?.message ?? 'The file was rejected.');
  }
}

function rejection(path: string, message: string): ImportRejected {
  return new ImportRejected([{ severity: 'error', path, message }]);
}

function toImportIssues(issues: readonly ValidationIssue[]): ImportIssue[] {
  return issues.map(({ severity, path, message }) => ({ severity, path, message }));
}

function errorsOf(issues: readonly ValidationIssue[]): ValidationIssue[] {
  return issues.filter((issue) => issue.severity === 'error');
}

/** The wallpaper library: validating imports, owning the files, resolving them for display. */
export class WallpaperLibrary {
  private readonly root: string;
  private readonly repository: WallpaperRepository;
  private readonly logger: Logger;

  constructor(options: LibraryOptions) {
    this.root = resolve(options.root);
    this.repository = options.repository;
    this.logger = options.logger;
  }

  /** Clears what an interrupted import or a failed removal left behind. */
  async initialise(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await rm(join(this.root, STAGING_DIRECTORY), { recursive: true, force: true });

    for (const id of await this.findOrphans()) {
      // Files are only ever deleted when a removal was started and marked. A folder with no
      // database row is not enough: if the database was reset or restored from a backup, those
      // folders are the user's wallpapers, and deleting them could not be undone.
      if (await exists(join(this.directoryOf(id), REMOVAL_MARKER))) {
        this.logger.info(LOG_SOURCE, 'library.finished-removal', { id });
        await rm(this.directoryOf(id), { recursive: true, force: true, ...REMOVE_RETRIES });
      } else {
        this.logger.warn(LOG_SOURCE, 'library.orphan-kept', { id });
      }
    }
  }

  list(query?: Parameters<WallpaperRepository['list']>[0]): WallpaperRecord[] {
    return this.repository.list(query).map(toRecord);
  }

  get(id: string): WallpaperRecord | null {
    const row = this.repository.find(id);
    return row ? toRecord(row) : null;
  }

  async importPath(path: string): Promise<ImportResult> {
    const fileName = basename(path);
    this.logger.info(LOG_SOURCE, 'import.start', { fileName });
    try {
      const localError = validateImportSource(path);
      if (localError) throw rejection(fileName, localError);

      const extension = extname(path).toLowerCase();
      const result = extension === PACKAGE_EXTENSION ? await this.importPackage(path) : await this.importMediaFile(path);

      this.logger.info(LOG_SOURCE, 'import.done', { fileName, id: result.wallpaper.id, type: result.wallpaper.type, warnings: result.warnings.length });
      return result;
    } catch (error) {
      if (error instanceof ImportRejected) {
        this.logger.warn(LOG_SOURCE, 'import.rejected', { fileName, issues: error.issues });
        return { status: 'rejected', fileName, issues: error.issues };
      }
      if (error instanceof PackageReadError) {
        this.logger.warn(LOG_SOURCE, 'import.rejected', { fileName, reason: error.message });
        return { status: 'rejected', fileName, issues: [{ severity: 'error', path: fileName, message: error.message }] };
      }
      this.logger.error(LOG_SOURCE, 'import.failed', { fileName, error });
      throw error;
    }
  }

  private async importPackage(path: string): Promise<Extract<ImportResult, { status: 'imported' }>> {
    const reader = await PackageReader.open(path);
    try {
      // Check the listing before reading anything from it, so a hostile archive is
      // rejected without ever touching its contents.
      const listingErrors = errorsOf(validatePackageListing(reader.listing));
      if (listingErrors.length > 0) throw new ImportRejected(toImportIssues(listingErrors));

      const parsed = parseManifest(await reader.readManifest());
      if (!parsed.ok) throw new ImportRejected(toImportIssues(errorsOf(parsed.issues)));
      const { manifest } = parsed;

      const crossCheck = errorsOf(validatePackageListing(reader.listing, manifest));
      if (crossCheck.length > 0) throw new ImportRejected(toImportIssues(crossCheck));

      this.ensureNotImported(manifest.id, manifest.name);

      const staging = await this.createStaging();
      try {
        await reader.extractAll(staging);
        await verifyManifestMedia(manifest, staging);

        const sizeBytes = reader.listing.reduce((sum, entry) => sum + entry.uncompressedBytes, 0);
        const id = randomUUID();
        const row = buildPackageRow(id, manifest, sizeBytes);
        await this.commit(staging, row);
        return { status: 'imported', wallpaper: toRecord(row), warnings: toImportIssues(parsed.issues) };
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
    } finally {
      reader.close();
    }
  }

  private async importMediaFile(path: string): Promise<Extract<ImportResult, { status: 'imported' }>> {
    const fileName = basename(path);
    const expected = mediaKindFromPath(path);
    if (!expected) {
      throw rejection(fileName, `This file type is not supported. Import one of: ${IMPORTABLE_EXTENSIONS.map((item) => `.${item}`).join(', ')}.`);
    }

    const info = await stat(path);
    if (!info.isFile()) throw rejection(fileName, 'This is not a file.');
    if (info.size > DEFAULT_PACKAGE_LIMITS.maxEntryBytes) throw rejection(fileName, 'This file is larger than the size limit.');

    const actual = await sniffFile(path);
    if (actual !== expected) {
      throw rejection(fileName, `The file's extension says ${expected.toUpperCase()}, but its contents are ${actual ? actual.toUpperCase() : 'not a supported media format'}.`);
    }

    // Identity comes from content, so importing the same file twice is detected even
    // when it has been renamed.
    const manifestId = `local.${await hashFile(path)}`;
    const name = cleanDisplayName(fileName);
    this.ensureNotImported(manifestId, name);

    const staging = await this.createStaging();
    try {
      const entryPath = `media${extname(path).toLowerCase()}`;
      await copyFile(path, join(staging, entryPath));

      const isVideo = VIDEO_KINDS.includes(actual);
      const size = isVideo ? null : await readFileImageSize(join(staging, entryPath));

      const manifest: WallpaperManifest = {
        formatVersion: CURRENT_FORMAT_VERSION,
        id: manifestId,
        name,
        creator: { name: 'Local file' },
        type: isVideo ? 'video' : 'image',
        entry: entryPath,
        preview: entryPath,
        resolution: { width: size?.width ?? 0, height: size?.height ?? 0 },
        audio: { hasAudio: false, defaultVolume: 0, startMuted: true },
        interaction: { mouse: false, keyboard: false },
        requiredCapabilities: ['gpu.d3d11'],
      };

      const id = randomUUID();
      const row: WallpaperRow = {
        ...buildPackageRow(id, manifest, info.size),
        source: 'media-file',
        preview_path: isVideo ? null : entryPath,
      };
      await this.commit(staging, row);
      return { status: 'imported', wallpaper: toRecord(row), warnings: [] };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  private ensureNotImported(manifestId: string, name: string): void {
    const existing = this.repository.findByManifestId(manifestId);
    if (existing) {
      throw rejection(name, `"${existing.name}" is already in your library.`);
    }
  }

  private async createStaging(): Promise<string> {
    const staging = join(this.root, STAGING_DIRECTORY, randomUUID());
    await mkdir(staging, { recursive: true });
    return staging;
  }

  /**
   * Moves files into place, then records them. Rename is atomic on one volume, so a
   * crash leaves either a staging directory that is cleaned on the next start, or a
   * complete wallpaper directory. A library row always has complete files behind it.
   */
  private async commit(staging: string, row: WallpaperRow): Promise<void> {
    const target = this.directoryOf(row.id);
    await renameWithRetry(staging, target);
    try {
      this.repository.insert(row);
    } catch (error) {
      await rm(target, { recursive: true, force: true });
      throw error;
    }
  }

  async remove(id: string): Promise<boolean> {
    if (!this.repository.find(id)) return false;

    // Marked first, so an interruption at any later point can be finished on the next start.
    // The marker alone never deletes anything while the database row still exists.
    const directory = this.directoryOf(id);
    await writeFile(join(directory, REMOVAL_MARKER), '').catch((error: unknown) => {
      this.logger.warn(LOG_SOURCE, 'wallpaper.marker-failed', { id, error });
    });

    this.repository.delete(id);
    try {
      await rm(directory, { recursive: true, force: true, ...REMOVE_RETRIES });
    } catch (error) {
      // The wallpaper is already gone from the library, so this is not a failure the user
      // can act on. A file was held open, and the folder is cleared on the next start.
      this.logger.warn(LOG_SOURCE, 'wallpaper.files-left-behind', { id, error });
    }
    this.logger.info(LOG_SOURCE, 'wallpaper.removed', { id });
    return true;
  }

  /**
   * Resolves a media request to a file. Paths come only from the database, never from
   * the request. A web wallpaper's entry point is never returned: untrusted HTML and
   * JavaScript must not reach the application's renderer.
   */
  resolveMedia(id: string, asset: MediaAsset): ResolvedMedia | null {
    const row = this.repository.find(id);
    if (!row) return null;

    const relativePath = asset === 'preview' ? row.preview_path : row.type === 'web' ? null : row.entry_path;
    if (!relativePath) return null;

    const kind = mediaKindFromPath(relativePath);
    if (!kind) return null;

    const directory = this.directoryOf(id);
    const path = resolve(directory, relativePath);
    if (!path.startsWith(directory + sep)) return null;
    return { path, kind };
  }

  /**
   * What the engine needs to play a wallpaper. A web wallpaper's entry point is withheld until
   * its sandboxed renderer exists, so the engine can never be handed its code by mistake.
   */
  playbackSource(id: string): { mediaPath: string | null; mediaType: WallpaperRow['type'] } | null {
    const row = this.repository.find(id);
    if (!row) return null;
    return { mediaPath: row.type === 'video' ? (this.resolveMedia(id, 'entry')?.path ?? null) : null, mediaType: row.type };
  }

  /** Directories named like one of our wallpapers that have no database row. */
  private async findOrphans(): Promise<string[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && WALLPAPER_ID.test(entry.name) && !this.repository.find(entry.name))
      .map((entry) => entry.name);
  }

  private directoryOf(id: string): string {
    // IDs are UUIDs we generate, but this path is about to be deleted or served, so a
    // malformed one is treated as a bug rather than trusted.
    if (!WALLPAPER_ID.test(id)) throw new Error(`Invalid wallpaper id: ${id}`);
    return join(this.root, id);
  }
}

/** Why a path may not be imported, or null. The path can originate in the renderer. */
export function validateImportSource(path: string): string | null {
  if (!isAbsolute(path) || !win32.isAbsolute(path)) return 'Only absolute file paths can be imported.';
  // Touching a UNC path makes Windows authenticate to that host, which would leak the
  // user's NTLM hash to an attacker-chosen server. Normalising first catches the mixed
  // forms, such as "/\\server\\share", that Windows also treats as UNC.
  if (win32.normalize(path).startsWith('\\\\')) return 'Files on network paths cannot be imported. Copy the file to this PC first.';
  const extension = extname(path).toLowerCase().slice(1);
  if (!IMPORTABLE_EXTENSIONS.includes(extension)) {
    return `This file type is not supported. Import one of: ${IMPORTABLE_EXTENSIONS.map((item) => `.${item}`).join(', ')}.`;
  }
  return null;
}

/**
 * Windows Defender and the search indexer briefly open files that were just written, which
 * makes renaming their folder fail. That clears by itself within moments.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (const delay of RENAME_RETRY_DELAYS_MS) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!TRANSIENT_RENAME_ERRORS.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await new Promise((done) => setTimeout(done, delay));
    }
  }
  await rename(from, to);
}

async function sniffFile(path: string): Promise<MediaKind | null> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    return sniffMediaKind(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Header parsing only: pixels from an untrusted file are never decoded in this process. */
async function readFileImageSize(path: string) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(IMAGE_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, IMAGE_HEADER_BYTES, 0);
    return readImageSize(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex').slice(0, 32);
}

/** Checks that a package's media really is what its manifest says. */
async function verifyManifestMedia(manifest: WallpaperManifest, directory: string): Promise<void> {
  const preview = await sniffFile(join(directory, manifest.preview));
  if (!preview || !IMAGE_KINDS.includes(preview)) {
    throw rejection('preview', `The preview "${manifest.preview}" is not a PNG, JPEG or WebP image.`);
  }

  if (manifest.type === 'web') return;
  const entry = await sniffFile(join(directory, manifest.entry));
  const allowed = manifest.type === 'video' ? VIDEO_KINDS : IMAGE_KINDS;
  if (!entry || !allowed.includes(entry)) {
    throw rejection('entry', `The entry "${manifest.entry}" does not contain ${manifest.type === 'video' ? 'MP4 or WebM video' : 'a PNG, JPEG or WebP image'}.`);
  }
}

function cleanDisplayName(fileName: string): string {
  const stem = stripUnsafeText(fileName.replace(/\.[^.]+$/, ''));
  const pretty = stem.replace(/[_-]+/g, ' ').trim();
  return (pretty || 'Untitled wallpaper').slice(0, 120);
}

function buildPackageRow(id: string, manifest: WallpaperManifest, sizeBytes: number): WallpaperRow {
  return {
    id,
    manifest_id: manifest.id,
    name: manifest.name,
    description: manifest.description ?? null,
    creator_name: manifest.creator.name,
    creator_url: manifest.creator.url ?? null,
    type: manifest.type,
    entry_path: manifest.entry,
    preview_path: manifest.preview,
    width: manifest.resolution.width,
    height: manifest.resolution.height,
    has_audio: manifest.audio.hasAudio ? 1 : 0,
    interactive: manifest.interaction.mouse || manifest.interaction.keyboard ? 1 : 0,
    source: 'package',
    format_version: manifest.formatVersion,
    size_bytes: sizeBytes,
    required_capabilities: JSON.stringify(manifest.requiredCapabilities),
    manifest_json: JSON.stringify(manifest),
    imported_at: new Date().toISOString(),
    last_used_at: null,
  };
}

function mediaUrl(id: string, asset: MediaAsset): string {
  return `${MEDIA_SCHEME}://library/${id}/${asset}`;
}

export function toRecord(row: WallpaperRow): WallpaperRecord {
  return {
    id: row.id,
    manifestId: row.manifest_id,
    name: row.name,
    description: row.description,
    creatorName: row.creator_name,
    creatorUrl: row.creator_url,
    type: row.type,
    width: row.width,
    height: row.height,
    hasAudio: row.has_audio === 1,
    interactive: row.interactive === 1,
    source: row.source,
    formatVersion: row.format_version,
    sizeBytes: row.size_bytes,
    importedAt: row.imported_at,
    lastUsedAt: row.last_used_at,
    requiredCapabilities: JSON.parse(row.required_capabilities) as string[],
    previewUrl: row.preview_path ? mediaUrl(row.id, 'preview') : null,
    videoUrl: row.type === 'video' ? mediaUrl(row.id, 'entry') : null,
  };
}
