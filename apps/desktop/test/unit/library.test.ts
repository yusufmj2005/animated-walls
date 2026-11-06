import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../electron/main/database/database';
import { WallpaperRepository } from '../../electron/main/database/wallpaperRepository';
import { parseRange } from '../../electron/main/mediaRange';
import { WallpaperLibrary, validateImportSource } from '../../electron/main/wallpapers/wallpaperLibrary';
import { MP4_BYTES, PNG_BYTES, VALID_MANIFEST, WEBM_BYTES, quietLogger, tempDirectory, validPackageEntries, writeZip, type ZipFileEntry } from './helpers';

describe('WallpaperLibrary', () => {
  let directory: ReturnType<typeof tempDirectory>;
  let logger: ReturnType<typeof quietLogger>;
  let db: DatabaseSync;
  let repository: WallpaperRepository;
  let library: WallpaperLibrary;
  let root: string;

  beforeEach(async () => {
    directory = tempDirectory();
    logger = quietLogger(directory.path);
    db = openDatabase(':memory:').db;
    repository = new WallpaperRepository(db);
    root = join(directory.path, 'library');
    library = new WallpaperLibrary({ root, repository, logger });
    await library.initialise();
  });

  afterEach(() => {
    db.close();
    logger.close();
    directory.cleanup();
  });

  const zipPath = (name = 'test.awall') => join(directory.path, name);
  const writePackage = (entries: ZipFileEntry[], name?: string) => writeZip(zipPath(name), entries);
  const writeFile = (name: string, content: Buffer | string) => {
    const path = join(directory.path, name);
    writeFileSync(path, content);
    return path;
  };

  const expectRejected = async (path: string, pattern: RegExp) => {
    const result = await library.importPath(path);
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.issues.map((issue) => issue.message).join(' | ')).toMatch(pattern);
    }
    // A rejection must leave nothing behind, on disk or in the database.
    expect(library.list()).toHaveLength(0);
    const stagingPath = join(root, '.staging');
    const staged = existsSync(stagingPath) ? readdirSync(stagingPath) : [];
    expect(staged).toEqual([]);
    expect(readdirSync(root).filter((name) => name !== '.staging')).toEqual([]);
  };

  describe('importing packages', () => {
    it('imports a valid package and stores its metadata', async () => {
      const result = await library.importPath(await writePackage(validPackageEntries()));
      expect(result.status).toBe('imported');
      if (result.status !== 'imported') return;

      expect(result.wallpaper).toMatchObject({ name: 'Test Wallpaper', creatorName: 'Tester', type: 'web', width: 1920, height: 1080, source: 'package' });
      expect(library.list()).toHaveLength(1);
      expect(readFileSync(join(root, result.wallpaper.id, 'preview.png'))).toEqual(PNG_BYTES);
    });

    it('extracts nested files', async () => {
      const result = await library.importPath(await writePackage([...validPackageEntries(), { name: 'assets/js/app.js', content: '1' }]));
      expect(result.status).toBe('imported');
      if (result.status === 'imported') expect(existsSync(join(root, result.wallpaper.id, 'assets', 'js', 'app.js'))).toBe(true);
    });

    it('imports a video package', async () => {
      const manifest = { ...VALID_MANIFEST, type: 'video', entry: 'clip.mp4' };
      const result = await library.importPath(await writePackage([{ name: 'manifest.json', content: JSON.stringify(manifest) }, { name: 'clip.mp4', content: MP4_BYTES }, { name: 'preview.png', content: PNG_BYTES }]));
      expect(result.status).toBe('imported');
      if (result.status === 'imported') expect(result.wallpaper.videoUrl).toContain('/entry');
    });

    it('rejects the same wallpaper twice', async () => {
      await library.importPath(await writePackage(validPackageEntries()));
      const second = await library.importPath(await writePackage(validPackageEntries(), 'second.awall'));
      expect(second.status).toBe('rejected');
      if (second.status === 'rejected') expect(second.issues[0]?.message).toMatch(/already in your library/);
      expect(library.list()).toHaveLength(1);
    });

    it('rejects a file that is not a ZIP', () => expectRejected(writeFile('fake.awall', 'not a zip file at all'), /not a valid wallpaper package/));

    it('rejects a package with no manifest', async () => {
      await expectRejected(await writePackage([{ name: 'index.html', content: 'x' }]), /no manifest\.json/);
    });

    it('rejects an invalid manifest', async () => {
      await expectRejected(await writePackage([{ name: 'manifest.json', content: '{broken' }]), /not valid JSON/);
    });

    it('rejects an oversized manifest', async () => {
      await expectRejected(await writePackage([{ name: 'manifest.json', content: ' '.repeat(70_000) }]), /larger than/);
    });

    it('rejects a missing entry file', async () => {
      await expectRejected(await writePackage([{ name: 'manifest.json', content: JSON.stringify(VALID_MANIFEST) }, { name: 'preview.png', content: PNG_BYTES }]), /entry file "index\.html" is not in the package/);
    });

    it('rejects executables hidden in a package', async () => {
      await expectRejected(await writePackage([...validPackageEntries(), { name: 'payload.exe', content: 'MZ' }]), /File type "\.exe" is not allowed/);
    });

    it('rejects path traversal in entry names', async () => {
      await expectRejected(await writePackage([...validPackageEntries(), { name: '../../../evil.js', content: 'x', rawName: true }]), /Unsafe file path/);
      expect(existsSync(join(directory.path, 'evil.js'))).toBe(false);
    });

    it('rejects backslash path traversal', async () => {
      await expectRejected(await writePackage([...validPackageEntries(), { name: '..\\..\\evil.js', content: 'x', rawName: true }]), /Unsafe file path/);
    });

    it('rejects absolute paths', async () => {
      await expectRejected(await writePackage([...validPackageEntries(), { name: 'C:/Windows/evil.js', content: 'x', rawName: true }]), /Unsafe file path/);
    });

    it('rejects symbolic links', async () => {
      await expectRejected(await writePackage([...validPackageEntries(), { name: 'link.js', content: '/etc/passwd', mode: 0o120777 }]), /symbolic links/);
    });

    it('rejects a preview that is not really an image', async () => {
      await expectRejected(await writePackage([{ name: 'manifest.json', content: JSON.stringify(VALID_MANIFEST) }, { name: 'index.html', content: 'x' }, { name: 'preview.png', content: '<script>alert(1)</script>' }]), /not a PNG, JPEG or WebP/);
    });

    it('rejects a video entry that is not really video', async () => {
      const manifest = { ...VALID_MANIFEST, type: 'video', entry: 'clip.mp4' };
      await expectRejected(await writePackage([{ name: 'manifest.json', content: JSON.stringify(manifest) }, { name: 'clip.mp4', content: 'MZ not a video' }, { name: 'preview.png', content: PNG_BYTES }]), /does not contain MP4 or WebM/);
    });

    it('reports a damaged package as a rejection and leaves nothing behind', async () => {
      const path = await writePackage([
        { name: 'manifest.json', content: JSON.stringify(VALID_MANIFEST) },
        { name: 'index.html', content: 'a'.repeat(200_000) },
        { name: 'preview.png', content: PNG_BYTES },
      ]);
      const bytes = readFileSync(path);
      const nameAt = bytes.indexOf(Buffer.from('index.html'));
      bytes.fill(0xff, nameAt + 20, nameAt + 60);
      writeFileSync(path, bytes);
      await expectRejected(path, /package is damaged.*index\.html/);
    });

    it('rejects too many files before reading the file list', async () => {
      const many = Array.from({ length: 10_001 }, (_, index) => ({ name: `f${index}.js`, content: '' }));
      await expectRejected(await writePackage(many), /at most 10000 files/);
    });

    it('rejects names that collide on a case-insensitive filesystem', async () => {
      await expectRejected(await writePackage([...validPackageEntries(), { name: 'INDEX.HTML', content: 'x' }]), /more than once/);
    });

    it('reports manifest warnings without failing', async () => {
      const result = await library.importPath(await writePackage(validPackageEntries({ ...VALID_MANIFEST, futureField: true })));
      expect(result.status).toBe('imported');
      if (result.status === 'imported') expect(result.warnings[0]?.message).toMatch(/futureField/);
    });
  });

  describe('importing media files', () => {
    it.each([
      ['clip.mp4', MP4_BYTES, 'video'],
      ['clip.webm', WEBM_BYTES, 'video'],
      ['still.png', PNG_BYTES, 'image'],
    ])('imports %s', async (name, bytes, type) => {
      const result = await library.importPath(writeFile(name, bytes));
      expect(result.status).toBe('imported');
      if (result.status === 'imported') {
        expect(result.wallpaper.type).toBe(type);
        expect(result.wallpaper.source).toBe('media-file');
      }
    });

    it('reads image dimensions from the file header', async () => {
      const png = Buffer.concat([PNG_BYTES, Buffer.from([0, 0, 0x0a, 0, 0, 0, 0x05, 0xa0])]);
      const result = await library.importPath(writeFile('sized.png', png));
      if (result.status !== 'imported') throw new Error('import failed');
      expect([result.wallpaper.width, result.wallpaper.height]).toEqual([2560, 1440]);
    });

    it('removes characters from a file name that would disguise it', async () => {
      const result = await library.importPath(writeFile('photo\u202Egnp.png', PNG_BYTES));
      if (result.status !== 'imported') throw new Error('import failed');
      expect(result.wallpaper.name).toBe('photognp');
    });

    it('builds a readable name from the file name', async () => {
      const result = await library.importPath(writeFile('my_cool-wallpaper.png', PNG_BYTES));
      if (result.status === 'imported') expect(result.wallpaper.name).toBe('my cool wallpaper');
    });

    it('rejects content that does not match its extension', () => expectRejected(writeFile('fake.mp4', 'MZ this is really an exe'), /extension says MP4/));

    it('rejects an executable renamed to an image', () => expectRejected(writeFile('photo.png', Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0])), /extension says PNG/));

    it('rejects unsupported file types', () => expectRejected(writeFile('virus.exe', 'MZ'), /not supported/));

    it('rejects HTML outside of a package', () => expectRejected(writeFile('page.html', '<script></script>'), /not supported/));

    it('recognises the same file under a new name', async () => {
      await library.importPath(writeFile('one.png', PNG_BYTES));
      const second = await library.importPath(writeFile('two.png', PNG_BYTES));
      expect(second.status).toBe('rejected');
      expect(library.list()).toHaveLength(1);
    });
  });

  describe('resolving media', () => {
    it('serves the preview of a web wallpaper but never its code', async () => {
      const result = await library.importPath(await writePackage(validPackageEntries()));
      if (result.status !== 'imported') throw new Error('import failed');
      expect(library.resolveMedia(result.wallpaper.id, 'preview')?.kind).toBe('png');
      expect(library.resolveMedia(result.wallpaper.id, 'entry')).toBeNull();
      expect(result.wallpaper.videoUrl).toBeNull();
    });

    it('serves a video entry', async () => {
      const result = await library.importPath(writeFile('clip.webm', WEBM_BYTES));
      if (result.status !== 'imported') throw new Error('import failed');
      expect(library.resolveMedia(result.wallpaper.id, 'entry')?.kind).toBe('webm');
    });

    it('returns nothing for unknown ids', () => {
      expect(library.resolveMedia('00000000-0000-0000-0000-000000000000', 'preview')).toBeNull();
      expect(library.resolveMedia('../../secrets', 'preview')).toBeNull();
    });
  });

  describe('removing', () => {
    it('deletes the files and the row', async () => {
      const result = await library.importPath(await writePackage(validPackageEntries()));
      if (result.status !== 'imported') throw new Error('import failed');
      expect(await library.remove(result.wallpaper.id)).toBe(true);
      expect(existsSync(join(root, result.wallpaper.id))).toBe(false);
      expect(library.list()).toHaveLength(0);
    });

    it('does not touch the original file', async () => {
      const original = writeFile('keep.png', PNG_BYTES);
      const result = await library.importPath(original);
      if (result.status !== 'imported') throw new Error('import failed');
      await library.remove(result.wallpaper.id);
      expect(existsSync(original)).toBe(true);
    });

    it('still removes a wallpaper whose file is open, as when its video is playing', async () => {
      const result = await library.importPath(writeFile('playing.webm', WEBM_BYTES));
      if (result.status !== 'imported') throw new Error('import failed');
      const media = library.resolveMedia(result.wallpaper.id, 'entry');
      const handle = await open(media!.path, 'r');
      try {
        expect(await library.remove(result.wallpaper.id)).toBe(true);
        expect(library.list()).toHaveLength(0);
      } finally {
        await handle.close();
      }
    });

    it('reports when the id is unknown', async () => {
      expect(await library.remove('00000000-0000-0000-0000-000000000000')).toBe(false);
    });
  });

  it('clears staging left by an interrupted import', async () => {
    const stale = join(root, '.staging', 'interrupted');
    mkdirSync(stale, { recursive: true });
    await library.initialise();
    expect(existsSync(stale)).toBe(false);
  });

  describe('at startup', () => {
    const id = '00000000-0000-0000-0000-000000000009';

    it('keeps wallpaper files when the database no longer knows them', async () => {
      // A deleted database or a restored backup must not cost the user their wallpapers.
      const result = await library.importPath(writeFile('kept.png', PNG_BYTES));
      if (result.status !== 'imported') throw new Error('import failed');

      const resetDb = openDatabase(':memory:').db;
      try {
        const reopened = new WallpaperLibrary({ root, repository: new WallpaperRepository(resetDb), logger });
        await reopened.initialise();
        expect(existsSync(join(root, result.wallpaper.id, 'media.png'))).toBe(true);
      } finally {
        resetDb.close();
      }
    });

    it('finishes a removal that was interrupted', async () => {
      mkdirSync(join(root, id));
      writeFileSync(join(root, id, '.removed'), '');
      await library.initialise();
      expect(existsSync(join(root, id))).toBe(false);
    });

    it('never deletes a wallpaper that is still in the database, even if marked', async () => {
      const result = await library.importPath(writeFile('live.png', PNG_BYTES));
      if (result.status !== 'imported') throw new Error('import failed');
      writeFileSync(join(root, result.wallpaper.id, '.removed'), '');
      await library.initialise();
      expect(library.get(result.wallpaper.id)).not.toBeNull();
      expect(existsSync(join(root, result.wallpaper.id, 'media.png'))).toBe(true);
    });

    it('ignores folders that are not ours', async () => {
      mkdirSync(join(root, 'not-one-of-ours'));
      writeFileSync(join(root, 'not-one-of-ours', '.removed'), '');
      await library.initialise();
      expect(existsSync(join(root, 'not-one-of-ours'))).toBe(true);
    });
  });
});

describe('validateImportSource', () => {
  it('accepts a local absolute path', () => {
    expect(validateImportSource('C:\\Users\\me\\clip.mp4')).toBeNull();
  });
  it.each([
    'clip.mp4',
    '..\\clip.mp4',
    '\\\\evil-server\\share\\clip.mp4',
    '//evil-server/share/clip.mp4',
    '/\\evil-server\\share\\clip.mp4',
    '\\/evil-server/share/clip.mp4',
    '\\\\?\\UNC\\evil-server\\share\\clip.mp4',
    '\\\\.\\C:\\clip.mp4',
    'C:\\Windows\\system32\\calc.exe',
    'C:\\x\\notes.txt',
  ])('rejects %s', (path) => {
    expect(validateImportSource(path)).not.toBeNull();
  });
});

describe('parseRange', () => {
  it.each([
    [null, 100, null],
    ['bytes=0-49', 100, { start: 0, end: 49 }],
    ['bytes=50-', 100, { start: 50, end: 99 }],
    ['bytes=-10', 100, { start: 90, end: 99 }],
    ['bytes=-500', 100, { start: 0, end: 99 }],
    ['bytes=90-500', 100, { start: 90, end: 99 }],
    ['bytes=100-', 100, 'unsatisfiable'],
    ['bytes=50-10', 100, 'unsatisfiable'],
    ['bytes=-0', 100, 'unsatisfiable'],
    ['bytes=-', 100, null],
    ['items=0-5', 100, null],
    ['bytes=0-5,10-20', 100, null],
  ])('parses %s of %i', (header, size, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });
});
