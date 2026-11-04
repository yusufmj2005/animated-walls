// Windows treats these device names as special in every directory and with any
// extension, so "CON.png" inside a package could not be extracted safely.
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

const MAX_PATH_LENGTH = 512;
const MAX_SEGMENT_LENGTH = 200;
const FORBIDDEN_CHARS = /[<>:"|?*\\\u0000-\u001f]/;

/**
 * Checks a path from an untrusted package. Returns a reason it is unsafe, or null
 * when it is a plain relative path that cannot leave the extraction directory.
 *
 * The rules cover what Windows does with paths as well as "..": colons open NTFS
 * alternate data streams, and trailing dots and spaces are stripped, which would
 * let "a.exe." or "a.png " bypass an extension check.
 */
export function validatePackagePath(path: string): string | null {
  if (path.length === 0) return 'the path is empty';
  if (path.length > MAX_PATH_LENGTH) return `the path is longer than ${MAX_PATH_LENGTH} characters`;
  if (path.startsWith('/')) return 'the path must be relative';
  if (FORBIDDEN_CHARS.test(path)) return 'the path contains characters that are not allowed';

  for (const segment of path.split('/')) {
    if (segment.length === 0) return 'the path contains an empty segment';
    if (segment === '.' || segment === '..') return 'the path contains a relative segment';
    if (segment.length > MAX_SEGMENT_LENGTH) return `a path segment is longer than ${MAX_SEGMENT_LENGTH} characters`;
    if (segment.endsWith('.') || segment.endsWith(' ')) return 'a path segment ends with a dot or space';
    const stem = segment.split('.')[0]?.toLowerCase() ?? '';
    if (RESERVED_NAMES.has(stem)) return `"${segment}" is a reserved Windows device name`;
  }
  return null;
}
