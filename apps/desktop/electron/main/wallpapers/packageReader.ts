import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';
import { DEFAULT_PACKAGE_LIMITS, MAX_MANIFEST_BYTES, MANIFEST_FILE_NAME, type PackageEntry } from '@animated-walls/wallpaper-format';

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const UNIX_HOST = 3;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export class PackageReadError extends Error {
  override name = 'PackageReadError';
}

interface RawEntry {
  listing: PackageEntry;
  zipEntry: yauzl.Entry;
}

/**
 * Reads an `.awall` file, which is a ZIP archive. File names are read as raw bytes
 * (decodeStrings: false) so hostile names reach our own validator and produce a clear
 * rejection, rather than an opaque failure inside the ZIP library.
 */
export class PackageReader {
  private constructor(
    private readonly zip: yauzl.ZipFile,
    private readonly entries: RawEntry[],
  ) {}

  static async open(path: string): Promise<PackageReader> {
    const zip = await new Promise<yauzl.ZipFile>((done, fail) => {
      yauzl.open(path, { lazyEntries: true, decodeStrings: false, autoClose: false, validateEntrySizes: true }, (error, file) => {
        if (error || !file) fail(new PackageReadError(`This file is not a valid wallpaper package: ${error?.message ?? 'unreadable archive'}`));
        else done(file);
      });
    });

    try {
      // Checked before reading the file list, which is what could exhaust memory. A crafted
      // archive of a few hundred megabytes can declare millions of entries.
      if (zip.entryCount > DEFAULT_PACKAGE_LIMITS.maxEntries) {
        throw new PackageReadError(`A package may contain at most ${DEFAULT_PACKAGE_LIMITS.maxEntries} files.`);
      }
      return new PackageReader(zip, await readAllEntries(zip));
    } catch (error) {
      zip.close();
      throw error;
    }
  }

  get listing(): PackageEntry[] {
    return this.entries.map((entry) => entry.listing);
  }

  /** Reads the manifest with a hard size limit, so it cannot exhaust memory. */
  async readManifest(): Promise<string> {
    const entry = this.entries.find((item) => item.listing.path === MANIFEST_FILE_NAME);
    if (!entry) throw new PackageReadError(`The package has no ${MANIFEST_FILE_NAME} at its root.`);
    if (entry.listing.uncompressedBytes > MAX_MANIFEST_BYTES) {
      throw new PackageReadError(`${MANIFEST_FILE_NAME} is larger than ${MAX_MANIFEST_BYTES} bytes.`);
    }

    const stream = await this.openStream(entry.zipEntry);
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        total += chunk.length;
        if (total > MAX_MANIFEST_BYTES) {
          stream.destroy();
          throw new PackageReadError(`${MANIFEST_FILE_NAME} is larger than ${MAX_MANIFEST_BYTES} bytes.`);
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof PackageReadError) throw error;
      throw damaged(MANIFEST_FILE_NAME);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /**
   * Extracts every file into `destination`. Call only after the listing has been
   * validated. Paths are still re-checked here: a check that protects the filesystem
   * should not depend on a caller having remembered another one.
   */
  async extractAll(destination: string): Promise<void> {
    const root = resolve(destination);
    for (const { listing, zipEntry } of this.entries) {
      const target = resolve(join(root, listing.path));
      const escaped = relative(root, target);
      if (escaped === '..' || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
        throw new PackageReadError(`Blocked a file path that leaves the package: ${listing.path}`);
      }
      if (listing.isDirectory) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      const stream = await this.openStream(zipEntry);
      try {
        await pipeline(stream, createWriteStream(target, { flags: 'wx' }));
      } catch (error) {
        // A full disk or a permissions problem says nothing about the package, and the user
        // needs to see those as they are. Anything else came from reading the archive.
        if (error instanceof Error && 'syscall' in error) throw error;
        throw damaged(listing.path);
      }
    }
  }

  close(): void {
    this.zip.close();
  }

  private openStream(entry: yauzl.Entry): Promise<Readable> {
    return new Promise((done, fail) => {
      this.zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) fail(new PackageReadError(`Could not read a file in the package: ${error?.message ?? 'unknown error'}`));
        else done(stream);
      });
    });
  }
}

function damaged(path: string): PackageReadError {
  return new PackageReadError(`The package is damaged: "${path}" could not be read. Try downloading it again.`);
}

function readAllEntries(zip: yauzl.ZipFile): Promise<RawEntry[]> {
  return new Promise((done, fail) => {
    const entries: RawEntry[] = [];
    zip.on('error', (error: Error) => fail(new PackageReadError(`The package is damaged: ${error.message}`)));
    zip.on('end', () => done(entries));
    zip.on('entry', (entry: yauzl.Entry) => {
      try {
        entries.push({ listing: describeEntry(entry), zipEntry: entry });
        zip.readEntry();
      } catch (error) {
        fail(error);
      }
    });
    zip.readEntry();
  });
}

function describeEntry(entry: yauzl.Entry): PackageEntry {
  let path: string;
  try {
    path = UTF8_DECODER.decode(entry.fileName as unknown as Buffer);
  } catch {
    throw new PackageReadError('The package contains a file name that is not valid UTF-8.');
  }

  const isDirectory = path.endsWith('/');
  const hostSystem = entry.versionMadeBy >> 8;
  const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;

  return {
    path,
    uncompressedBytes: entry.uncompressedSize,
    compressedBytes: entry.compressedSize,
    isDirectory,
    isSymlink: hostSystem === UNIX_HOST && mode === S_IFLNK,
    isEncrypted: (entry.generalPurposeBitFlag & 0x1) !== 0,
  };
}
