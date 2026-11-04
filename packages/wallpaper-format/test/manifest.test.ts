import { describe, expect, it } from 'vitest';
import {
  CURRENT_FORMAT_VERSION,
  DEFAULT_PACKAGE_LIMITS,
  parseManifest,
  sniffMediaKind,
  validatePackageListing,
  validatePackagePath,
  type PackageEntry,
  type WallpaperManifest,
} from '../src/index';

const valid = {
  formatVersion: 1,
  id: 'com.example.aurora',
  name: 'Aurora',
  creator: { name: 'Example Studio', url: 'https://example.com' },
  type: 'web',
  entry: 'index.html',
  preview: 'preview.png',
  resolution: { width: 3840, height: 2160 },
  audio: { hasAudio: false, defaultVolume: 0, startMuted: true },
  interaction: { mouse: true, keyboard: false },
  requiredCapabilities: ['gpu.d3d11'],
};

function parse(overrides: Record<string, unknown> = {}) {
  return parseManifest(JSON.stringify({ ...valid, ...overrides }));
}

function codes(result: ReturnType<typeof parseManifest>): string[] {
  return result.issues.map((issue) => `${issue.path}:${issue.code}`);
}

describe('parseManifest', () => {
  it('accepts a valid manifest', () => {
    const result = parse();
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    if (result.ok) expect(result.manifest.name).toBe('Aurora');
  });

  it('adds the WebView2 capability to web wallpapers', () => {
    const result = parse();
    if (!result.ok) throw new Error('expected a valid manifest');
    expect(result.manifest.requiredCapabilities).toContain('runtime.webview2');
  });

  it('tolerates a UTF-8 byte order mark', () => {
    expect(parseManifest(`\ufeff${JSON.stringify(valid)}`).ok).toBe(true);
  });

  it('fills safe defaults for optional audio and interaction', () => {
    const { audio: _audio, interaction: _interaction, ...rest } = valid;
    const result = parseManifest(JSON.stringify(rest));
    if (!result.ok) throw new Error('expected a valid manifest');
    expect(result.manifest.audio).toEqual({ hasAudio: false, defaultVolume: 0, startMuted: true });
    expect(result.manifest.interaction).toEqual({ mouse: false, keyboard: false });
  });

  it('rejects invalid JSON', () => {
    expect(codes(parseManifest('{nope'))).toEqual(['$:invalid-json']);
  });

  it('rejects non-object JSON', () => {
    expect(codes(parseManifest('[]'))).toEqual(['$:type']);
  });

  it('rejects oversized manifests before parsing', () => {
    const huge = JSON.stringify({ ...valid, description: 'x'.repeat(70_000) });
    expect(codes(parseManifest(huge))).toEqual(['$:too-large']);
  });

  it('rejects manifests from a newer format', () => {
    const result = parse({ formatVersion: CURRENT_FORMAT_VERSION + 1 });
    expect(codes(result)).toEqual(['formatVersion:unsupported-version']);
  });

  it.each([
    [{ id: 'Has Spaces' }, 'id:format'],
    [{ id: undefined }, 'id:missing'],
    [{ name: '' }, 'name:empty'],
    [{ name: 42 }, 'name:type'],
    [{ name: 'bad\u0007name' }, 'name:control-characters'],
    [{ creator: 'someone' }, 'creator:type'],
    [{ creator: { name: 'x', url: 'javascript:alert(1)' } }, 'creator.url:scheme'],
    [{ creator: { name: 'x', url: 'http://example.com' } }, 'creator.url:scheme'],
    [{ type: 'executable' }, 'type:invalid'],
    [{ entry: '../../evil.html' }, 'entry:unsafe-path'],
    [{ entry: 'C:/Windows/evil.html' }, 'entry:unsafe-path'],
    [{ entry: 'app.exe' }, 'entry:extension'],
    [{ type: 'video', entry: 'index.html' }, 'entry:extension'],
    [{ preview: 'preview.gif' }, 'preview:extension'],
    [{ resolution: { width: 0, height: 100 } }, 'resolution.width:range'],
    [{ resolution: { width: 1.5, height: 100 } }, 'resolution.width:range'],
    [{ audio: { defaultVolume: 2 } }, 'audio.defaultVolume:range'],
    [{ interaction: { mouse: 'yes' } }, 'interaction.mouse:type'],
    [{ requiredCapabilities: 'gpu.d3d11' }, 'requiredCapabilities:type'],
  ])('rejects %j', (overrides, expected) => {
    const result = parse(overrides);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain(expected);
  });

  it('warns but accepts unknown capabilities and fields', () => {
    const result = parse({ requiredCapabilities: ['future.thing'], extra: true });
    expect(result.ok).toBe(true);
    expect(codes(result)).toEqual(expect.arrayContaining(['extra:unknown-field', 'requiredCapabilities[0]:unknown-capability']));
  });

  it('does not carry unknown keys onto the result', () => {
    const result = parseManifest(JSON.stringify(valid).replace('{', '{"__proto__":{"polluted":true},"extra":1,'));
    if (!result.ok) throw new Error('expected a valid manifest');
    expect(result.manifest).not.toHaveProperty('extra');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('validatePackagePath', () => {
  it.each(['index.html', 'assets/images/a.png', 'a-b_c.d.png'])('accepts %s', (path) => {
    expect(validatePackagePath(path)).toBeNull();
  });

  it.each([
    '',
    '/abs.png',
    '../up.png',
    'a/../../up.png',
    './a.png',
    'a//b.png',
    'a\\b.png',
    'C:/x.png',
    'file.png:hidden',
    'CON.png',
    'assets/nul',
    'trailing.png.',
    'trailing.png ',
    'bad\u0000name.png',
    `${'x'.repeat(600)}.png`,
  ])('rejects %j', (path) => {
    expect(validatePackagePath(path)).not.toBeNull();
  });
});

describe('sniffMediaKind', () => {
  const bytes = (...values: number[]) => new Uint8Array(values);
  const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));

  it('identifies each supported format', () => {
    expect(sniffMediaKind(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('png');
    expect(sniffMediaKind(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
    expect(sniffMediaKind(bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')))).toBe('webp');
    expect(sniffMediaKind(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe('webm');
    expect(sniffMediaKind(bytes(0, 0, 0, 24, ...ascii('ftypisom')))).toBe('mp4');
  });

  it('does not recognise an executable', () => {
    expect(sniffMediaKind(bytes(0x4d, 0x5a, 0x90, 0x00))).toBeNull();
  });
});

describe('validatePackageListing', () => {
  const file = (path: string, overrides: Partial<PackageEntry> = {}): PackageEntry => ({
    path,
    uncompressedBytes: 100,
    compressedBytes: 90,
    isDirectory: false,
    isSymlink: false,
    isEncrypted: false,
    ...overrides,
  });
  const manifest = { entry: 'index.html', preview: 'preview.png' } as WallpaperManifest;
  const base = [file('manifest.json'), file('index.html'), file('preview.png')];
  const issueCodes = (entries: PackageEntry[]) => validatePackageListing(entries, manifest).map((i) => i.code);

  it('accepts a well-formed package', () => {
    expect(validatePackageListing([...base, file('assets/'), file('assets/app.js')], manifest).filter((i) => i.code !== 'file-type')).toEqual([]);
  });

  it('requires the entry and preview files', () => {
    expect(issueCodes([file('manifest.json')])).toEqual(['not-found', 'not-found']);
  });

  it.each([
    ['payload.exe', 'file-type'],
    ['payload.dll', 'file-type'],
    ['payload.ps1', 'file-type'],
    ['noextension', 'file-type'],
    ['../escape.png', 'unsafe-path'],
    ['a\\b.png', 'unsafe-path'],
  ])('rejects %s', (path, code) => {
    expect(issueCodes([...base, file(path)])).toContain(code);
  });

  it('rejects symbolic links and encrypted files', () => {
    expect(issueCodes([...base, file('link.png', { isSymlink: true })])).toContain('symlink');
    expect(issueCodes([...base, file('secret.png', { isEncrypted: true })])).toContain('encrypted');
  });

  it('rejects names that differ only by case', () => {
    expect(issueCodes([...base, file('INDEX.html')])).toContain('duplicate');
  });

  it('rejects zip bombs by ratio', () => {
    const bomb = file('bomb.js', { uncompressedBytes: 2 * 1024 ** 3, compressedBytes: 1024 });
    expect(issueCodes([...base, bomb])).toContain('compression-ratio');
  });

  it('enforces the entry, per-file and total limits', () => {
    const limits = { ...DEFAULT_PACKAGE_LIMITS, maxEntries: 2, maxEntryBytes: 50, maxTotalBytes: 120 };
    const codesFound = validatePackageListing(base, manifest, limits).map((i) => i.code);
    expect(codesFound).toEqual(expect.arrayContaining(['too-many-entries', 'too-large']));
  });
});
