import { mkdtempSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { Logger } from '../../electron/main/logging/logger';

export function tempDirectory(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'awall-test-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true, maxRetries: 3 }) };
}

export function quietLogger(directory: string): Logger {
  return new Logger({ directory, fileName: 'test.log' });
}

export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
export const WEBM_BYTES = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
export const MP4_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)]);

export const VALID_MANIFEST = {
  formatVersion: 1,
  id: 'com.example.test',
  name: 'Test Wallpaper',
  creator: { name: 'Tester' },
  type: 'web',
  entry: 'index.html',
  preview: 'preview.png',
  resolution: { width: 1920, height: 1080 },
};

export interface ZipFileEntry {
  name: string;
  content: Buffer | string;
  /** Written as-is, skipping yazl's own name validation, to imitate a hostile archive. */
  rawName?: boolean;
  mode?: number;
}

export async function writeZip(path: string, entries: ZipFileEntry[]): Promise<string> {
  const zip = new yazl.ZipFile();
  for (const entry of entries) {
    const options = entry.mode !== undefined ? { mode: entry.mode } : {};
    if (entry.rawName) {
      // yazl refuses unsafe names, which is good, so write a placeholder of the same
      // length and patch the bytes afterwards. See patchZipName.
      zip.addBuffer(Buffer.from(entry.content), placeholderFor(entry.name), options);
    } else {
      zip.addBuffer(Buffer.from(entry.content), entry.name, options);
    }
  }
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(path));

  const raw = entries.filter((entry) => entry.rawName);
  if (raw.length > 0) {
    const { readFileSync } = await import('node:fs');
    let bytes: Buffer = readFileSync(path);
    for (const entry of raw) bytes = patchZipName(bytes, placeholderFor(entry.name), entry.name);
    writeFileSync(path, bytes);
  }
  return path;
}

function placeholderFor(name: string): string {
  return 'x'.repeat(name.length);
}

function patchZipName(bytes: Buffer, from: string, to: string): Buffer {
  const source = Buffer.from(from, 'utf8');
  const target = Buffer.from(to, 'utf8');
  if (source.length !== target.length) throw new Error('Name patches must keep the length.');
  let index = bytes.indexOf(source);
  while (index !== -1) {
    target.copy(bytes, index);
    index = bytes.indexOf(source, index + 1);
  }
  return bytes;
}

export function validPackageEntries(manifest: object = VALID_MANIFEST): ZipFileEntry[] {
  return [
    { name: 'manifest.json', content: JSON.stringify(manifest) },
    { name: 'index.html', content: '<!doctype html><title>x</title>' },
    { name: 'preview.png', content: PNG_BYTES },
  ];
}
