export type MediaKind = 'mp4' | 'webm' | 'png' | 'jpeg' | 'webp';

const EXTENSION_KINDS: Record<string, MediaKind> = {
  '.mp4': 'mp4',
  '.webm': 'webm',
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.webp': 'webp',
};

const KIND_MIME: Record<MediaKind, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** Bytes needed by {@link sniffMediaKind} to identify every supported format. */
export const SNIFF_BYTES = 16;

export function mediaKindFromPath(path: string): MediaKind | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  return EXTENSION_KINDS[path.slice(dot).toLowerCase()] ?? null;
}

export function mimeForMediaKind(kind: MediaKind): string {
  return KIND_MIME[kind];
}

function matches(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (bytes.length < offset + expected.length) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

function matchesAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  return matches(bytes, offset, Array.from(text, (char) => char.charCodeAt(0)));
}

/**
 * Identifies media from file content. A file's extension is only a claim made by
 * whoever created it, so media is never trusted on extension alone.
 */
export function sniffMediaKind(bytes: Uint8Array): MediaKind | null {
  if (matches(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (matches(bytes, 0, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (matchesAscii(bytes, 0, 'RIFF') && matchesAscii(bytes, 8, 'WEBP')) return 'webp';
  if (matches(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm';
  if (matchesAscii(bytes, 4, 'ftyp')) return 'mp4';
  return null;
}
