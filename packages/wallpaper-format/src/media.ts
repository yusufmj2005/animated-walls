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

export interface ImageSize {
  width: number;
  height: number;
}

/** Bytes worth reading for {@link readImageSize}. JPEG metadata can push the size far in. */
export const IMAGE_HEADER_BYTES = 1024 * 1024;

const JPEG_SIZE_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/**
 * Reads an image's dimensions from its header without decoding any pixels. Decoding an untrusted
 * image in the app's privileged main process would expose it to any decoder vulnerability.
 */
export function readImageSize(bytes: Uint8Array): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = sniffMediaKind(bytes);
  let size: ImageSize | null = null;
  if (kind === 'png') size = readPngSize(view);
  else if (kind === 'jpeg') size = readJpegSize(view);
  else if (kind === 'webp') size = readWebpSize(view, bytes);
  return size && size.width > 0 && size.height > 0 ? size : null;
}

function readPngSize(view: DataView): ImageSize | null {
  if (view.byteLength < 24) return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function readJpegSize(view: DataView): ImageSize | null {
  let offset = 2;
  while (offset + 9 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return null;
    const marker = view.getUint8(offset + 1);
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (JPEG_SIZE_MARKERS.has(marker)) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    const length = view.getUint16(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function readWebpSize(view: DataView, bytes: Uint8Array): ImageSize | null {
  if (view.byteLength < 30) return null;
  if (matchesAscii(bytes, 12, 'VP8X')) {
    const read24 = (at: number): number => view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16);
    return { width: read24(24) + 1, height: read24(27) + 1 };
  }
  if (matchesAscii(bytes, 12, 'VP8L')) {
    if (view.getUint8(20) !== 0x2f) return null;
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (matchesAscii(bytes, 12, 'VP8 ')) {
    if (!matches(bytes, 23, [0x9d, 0x01, 0x2a])) return null;
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  return null;
}
