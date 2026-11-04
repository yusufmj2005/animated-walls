import type { ValidationIssue, WallpaperManifest } from './manifest';
import { validatePackagePath } from './paths';

export const MANIFEST_FILE_NAME = 'manifest.json';
export const PACKAGE_EXTENSION = '.awall';

/**
 * File types a package may contain. Anything else, especially executables and
 * scripts Windows would run directly, rejects the whole package.
 */
export const ALLOWED_PACKAGE_EXTENSIONS: readonly string[] = [
  '.mp4', '.webm',
  '.html', '.htm', '.css', '.js', '.mjs',
  '.png', '.jpg', '.jpeg', '.webp',
  '.json',
];

export interface PackageLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  /** Largest allowed uncompressed-to-compressed ratio, a zip bomb guard. */
  maxCompressionRatio: number;
}

export const DEFAULT_PACKAGE_LIMITS: PackageLimits = {
  maxEntries: 10_000,
  maxEntryBytes: 8 * 1024 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024 * 1024,
  maxCompressionRatio: 200,
};

export interface PackageEntry {
  path: string;
  uncompressedBytes: number;
  compressedBytes: number;
  isDirectory: boolean;
  isSymlink: boolean;
  isEncrypted: boolean;
}

/**
 * Validates a package's file listing before anything is written to disk, so a
 * rejected package leaves no trace. Pass `manifest` once it has been parsed; the
 * entry and preview cross-checks are skipped when it is omitted.
 */
export function validatePackageListing(
  entries: readonly PackageEntry[],
  manifest?: WallpaperManifest,
  limits: PackageLimits = DEFAULT_PACKAGE_LIMITS,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (path: string, code: string, message: string): void => {
    issues.push({ severity: 'error', path, code, message });
  };

  if (entries.length > limits.maxEntries) {
    error('$', 'too-many-entries', `A package may contain at most ${limits.maxEntries} files.`);
  }

  const seen = new Set<string>();
  const files = new Set<string>();
  let totalBytes = 0;

  for (const entry of entries) {
    const path = entry.isDirectory ? entry.path.replace(/\/$/, '') : entry.path;
    const pathError = validatePackagePath(path);
    if (pathError) {
      error(entry.path, 'unsafe-path', `Unsafe file path: ${pathError}.`);
      continue;
    }
    if (entry.isSymlink) {
      error(entry.path, 'symlink', 'Packages must not contain symbolic links.');
      continue;
    }
    if (entry.isEncrypted) {
      error(entry.path, 'encrypted', 'Packages must not contain encrypted files.');
      continue;
    }

    // NTFS is case-insensitive, so "A.png" and "a.png" would overwrite each other.
    const folded = path.toLowerCase();
    if (seen.has(folded)) {
      error(entry.path, 'duplicate', 'The package lists this file more than once.');
      continue;
    }
    seen.add(folded);

    if (entry.isDirectory) continue;
    files.add(path);

    const dot = path.lastIndexOf('.');
    const extension = dot > path.lastIndexOf('/') ? path.slice(dot).toLowerCase() : '';
    if (!ALLOWED_PACKAGE_EXTENSIONS.includes(extension)) {
      error(entry.path, 'file-type', `File type "${extension || 'none'}" is not allowed in a wallpaper package.`);
    }
    if (entry.uncompressedBytes > limits.maxEntryBytes) {
      error(entry.path, 'too-large', 'This file is larger than the per-file limit.');
    }
    const compressed = Math.max(entry.compressedBytes, 1);
    // Very small files compress at silly ratios legitimately, so only bigger ones count.
    if (entry.uncompressedBytes > 1024 * 1024 && entry.uncompressedBytes / compressed > limits.maxCompressionRatio) {
      error(entry.path, 'compression-ratio', 'This file is compressed too heavily to be extracted safely.');
    }
    totalBytes += entry.uncompressedBytes;
  }

  if (totalBytes > limits.maxTotalBytes) {
    error('$', 'too-large', 'The package is larger than the total size limit.');
  }

  if (manifest) {
    if (!files.has(manifest.entry)) {
      error('entry', 'not-found', `The entry file "${manifest.entry}" is not in the package.`);
    }
    if (!files.has(manifest.preview)) {
      error('preview', 'not-found', `The preview image "${manifest.preview}" is not in the package.`);
    }
  }

  return issues;
}
