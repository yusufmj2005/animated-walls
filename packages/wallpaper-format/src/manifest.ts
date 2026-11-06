import { validatePackagePath } from './paths';

/** The newest manifest format this build understands. */
export const CURRENT_FORMAT_VERSION = 1;

/** Manifests are metadata. Anything larger is malformed or hostile. */
export const MAX_MANIFEST_BYTES = 64 * 1024;

export const WALLPAPER_TYPES = ['video', 'image', 'web'] as const;
export type WallpaperType = (typeof WALLPAPER_TYPES)[number];

export const KNOWN_CAPABILITIES = [
  'gpu.d3d11',
  'decode.h264',
  'decode.hevc',
  'decode.vp8',
  'decode.vp9',
  'decode.av1',
  'runtime.webview2',
] as const;
export type EngineCapability = (typeof KNOWN_CAPABILITIES)[number];

export interface WallpaperManifest {
  formatVersion: number;
  id: string;
  name: string;
  description?: string;
  creator: { name: string; url?: string };
  type: WallpaperType;
  entry: string;
  preview: string;
  resolution: { width: number; height: number };
  audio: { hasAudio: boolean; defaultVolume: number; startMuted: boolean };
  interaction: { mouse: boolean; keyboard: boolean };
  requiredCapabilities: string[];
}

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: IssueSeverity;
  /** Dotted path of the offending field, or a package path. */
  path: string;
  code: string;
  message: string;
}

export type ManifestResult =
  | { ok: true; manifest: WallpaperManifest; issues: ValidationIssue[] }
  | { ok: false; issues: ValidationIssue[] };

const ENTRY_EXTENSIONS: Record<WallpaperType, readonly string[]> = {
  video: ['.mp4', '.webm'],
  image: ['.png', '.jpg', '.jpeg', '.webp'],
  web: ['.html', '.htm'],
};
const PREVIEW_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_CHARS_EXCEPT_LINE_BREAKS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const KNOWN_TOP_LEVEL_KEYS = new Set([
  'formatVersion',
  'id',
  'name',
  'description',
  'creator',
  'type',
  'entry',
  'preview',
  'resolution',
  'audio',
  'interaction',
  'requiredCapabilities',
]);

class Collector {
  readonly issues: ValidationIssue[] = [];
  error(path: string, code: string, message: string): void {
    this.issues.push({ severity: 'error', path, code, message });
  }
  warn(path: string, code: string, message: string): void {
    this.issues.push({ severity: 'warning', path, code, message });
  }
  get hasErrors(): boolean {
    return this.issues.some((issue) => issue.severity === 'error');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readText(
  source: Record<string, unknown>,
  key: string,
  path: string,
  maxLength: number,
  issues: Collector,
  required = true,
  allowLineBreaks = false,
): string | undefined {
  const value = source[key];
  if (value === undefined) {
    if (required) issues.error(path, 'missing', `"${path}" is required.`);
    return undefined;
  }
  if (typeof value !== 'string') {
    issues.error(path, 'type', `"${path}" must be a string.`);
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    issues.error(path, 'empty', `"${path}" must not be empty.`);
    return undefined;
  }
  if (trimmed.length > maxLength) {
    issues.error(path, 'too-long', `"${path}" must be at most ${maxLength} characters.`);
    return undefined;
  }
  if ((allowLineBreaks ? CONTROL_CHARS_EXCEPT_LINE_BREAKS : CONTROL_CHARS).test(trimmed)) {
    issues.error(path, 'control-characters', `"${path}" must not contain control characters.`);
    return undefined;
  }
  return trimmed;
}

function readBoolean(
  source: Record<string, unknown>,
  key: string,
  path: string,
  fallback: boolean,
  issues: Collector,
): boolean {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    issues.error(path, 'type', `"${path}" must be true or false.`);
    return fallback;
  }
  return value;
}

function extensionOf(path: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash ? path.slice(dot).toLowerCase() : '';
}

function readPackagePath(
  source: Record<string, unknown>,
  key: string,
  allowedExtensions: readonly string[] | undefined,
  issues: Collector,
): string | undefined {
  const value = readText(source, key, key, 512, issues);
  if (value === undefined) return undefined;
  const pathError = validatePackagePath(value);
  if (pathError) {
    issues.error(key, 'unsafe-path', `"${key}" is not a safe package path: ${pathError}`);
    return undefined;
  }
  if (allowedExtensions && !allowedExtensions.includes(extensionOf(value))) {
    issues.error(key, 'extension', `"${key}" must be one of: ${allowedExtensions.join(', ')}.`);
    return undefined;
  }
  return value;
}

/**
 * Parses and validates an `.awall` manifest. Accepts raw JSON text so size, BOM
 * and syntax failures are reported the same way as schema failures. The returned
 * object is rebuilt field by field, so unknown keys never reach the application.
 */
export function parseManifest(input: string): ManifestResult {
  const issues = new Collector();

  if (input.length > MAX_MANIFEST_BYTES) {
    issues.error('$', 'too-large', `The manifest must be at most ${MAX_MANIFEST_BYTES} bytes.`);
    return { ok: false, issues: issues.issues };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.charCodeAt(0) === 0xfeff ? input.slice(1) : input);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    issues.error('$', 'invalid-json', `The manifest is not valid JSON: ${detail}`);
    return { ok: false, issues: issues.issues };
  }

  if (!isRecord(parsed)) {
    issues.error('$', 'type', 'The manifest must be a JSON object.');
    return { ok: false, issues: issues.issues };
  }
  const root = parsed;

  // The version decides how everything else is read, so it is checked first.
  const formatVersion = root['formatVersion'];
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion) || formatVersion < 1) {
    issues.error('formatVersion', 'invalid', '"formatVersion" must be a positive whole number.');
    return { ok: false, issues: issues.issues };
  }
  if (formatVersion > CURRENT_FORMAT_VERSION) {
    issues.error(
      'formatVersion',
      'unsupported-version',
      `This wallpaper needs format ${formatVersion}, but this version of Animated Walls supports up to ${CURRENT_FORMAT_VERSION}. Update the app to use it.`,
    );
    return { ok: false, issues: issues.issues };
  }

  for (const key of Object.keys(root)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      issues.warn(key, 'unknown-field', `Unknown field "${key}" was ignored.`);
    }
  }

  const id = readText(root, 'id', 'id', 128, issues);
  if (id !== undefined && !ID_PATTERN.test(id)) {
    issues.error('id', 'format', '"id" may only use lowercase letters, digits, and single ".", "_" or "-" separators.');
  }

  const name = readText(root, 'name', 'name', 120, issues);
  const description = readText(root, 'description', 'description', 2000, issues, false, true);

  let creator: WallpaperManifest['creator'] | undefined;
  const rawCreator = root['creator'];
  if (!isRecord(rawCreator)) {
    issues.error('creator', rawCreator === undefined ? 'missing' : 'type', '"creator" must be an object with a "name".');
  } else {
    const creatorName = readText(rawCreator, 'name', 'creator.name', 120, issues);
    const creatorUrl = readText(rawCreator, 'url', 'creator.url', 512, issues, false);
    if (creatorUrl !== undefined && !isHttpsUrl(creatorUrl)) {
      issues.error('creator.url', 'scheme', '"creator.url" must be an https:// address.');
    }
    if (creatorName !== undefined) {
      creator = creatorUrl !== undefined ? { name: creatorName, url: creatorUrl } : { name: creatorName };
    }
  }

  const rawType = root['type'];
  let type: WallpaperType | undefined;
  if (typeof rawType === 'string' && (WALLPAPER_TYPES as readonly string[]).includes(rawType)) {
    type = rawType as WallpaperType;
  } else {
    issues.error('type', rawType === undefined ? 'missing' : 'invalid', `"type" must be one of: ${WALLPAPER_TYPES.join(', ')}.`);
  }

  const entry = readPackagePath(root, 'entry', type ? ENTRY_EXTENSIONS[type] : undefined, issues);
  const preview = readPackagePath(root, 'preview', PREVIEW_EXTENSIONS, issues);

  let resolution: WallpaperManifest['resolution'] | undefined;
  const rawResolution = root['resolution'];
  if (!isRecord(rawResolution)) {
    issues.error('resolution', rawResolution === undefined ? 'missing' : 'type', '"resolution" must be an object with "width" and "height".');
  } else {
    const width = readDimension(rawResolution, 'width', issues);
    const height = readDimension(rawResolution, 'height', issues);
    if (width !== undefined && height !== undefined) resolution = { width, height };
  }

  const audio = readAudio(root['audio'], issues);
  const interaction = readInteraction(root['interaction'], issues);
  const requiredCapabilities = readCapabilities(root['requiredCapabilities'], issues);

  if (type === 'web' && !requiredCapabilities.includes('runtime.webview2')) {
    requiredCapabilities.push('runtime.webview2');
  }

  if (
    issues.hasErrors ||
    id === undefined ||
    name === undefined ||
    creator === undefined ||
    type === undefined ||
    entry === undefined ||
    preview === undefined ||
    resolution === undefined
  ) {
    return { ok: false, issues: issues.issues };
  }

  const manifest: WallpaperManifest = {
    formatVersion,
    id,
    name,
    creator,
    type,
    entry,
    preview,
    resolution,
    audio,
    interaction,
    requiredCapabilities,
  };
  if (description !== undefined) manifest.description = description;
  return { ok: true, manifest, issues: issues.issues };
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function readDimension(source: Record<string, unknown>, key: 'width' | 'height', issues: Collector): number | undefined {
  const value = source[key];
  const path = `resolution.${key}`;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 16384) {
    issues.error(path, 'range', `"${path}" must be a whole number from 1 to 16384.`);
    return undefined;
  }
  return value;
}

function readAudio(value: unknown, issues: Collector): WallpaperManifest['audio'] {
  const fallback = { hasAudio: false, defaultVolume: 0, startMuted: true };
  if (value === undefined) return fallback;
  if (!isRecord(value)) {
    issues.error('audio', 'type', '"audio" must be an object.');
    return fallback;
  }
  const hasAudio = readBoolean(value, 'hasAudio', 'audio.hasAudio', false, issues);
  const startMuted = readBoolean(value, 'startMuted', 'audio.startMuted', true, issues);
  const rawVolume = value['defaultVolume'];
  let defaultVolume = 0;
  if (rawVolume !== undefined) {
    if (typeof rawVolume !== 'number' || !Number.isFinite(rawVolume) || rawVolume < 0 || rawVolume > 1) {
      issues.error('audio.defaultVolume', 'range', '"audio.defaultVolume" must be a number from 0 to 1.');
    } else {
      defaultVolume = rawVolume;
    }
  }
  return { hasAudio, defaultVolume, startMuted };
}

function readInteraction(value: unknown, issues: Collector): WallpaperManifest['interaction'] {
  if (value === undefined) return { mouse: false, keyboard: false };
  if (!isRecord(value)) {
    issues.error('interaction', 'type', '"interaction" must be an object.');
    return { mouse: false, keyboard: false };
  }
  return {
    mouse: readBoolean(value, 'mouse', 'interaction.mouse', false, issues),
    keyboard: readBoolean(value, 'keyboard', 'interaction.keyboard', false, issues),
  };
}

function readCapabilities(value: unknown, issues: Collector): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) {
    issues.error('requiredCapabilities', 'type', '"requiredCapabilities" must be a list of at most 32 names.');
    return [];
  }
  const result = new Set<string>();
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.length === 0 || item.length > 64) {
      issues.error(`requiredCapabilities[${index}]`, 'type', 'Each capability must be a short text name.');
      return;
    }
    if (!(KNOWN_CAPABILITIES as readonly string[]).includes(item)) {
      // A newer creator tool may declare a capability this build has not heard of.
      // The wallpaper still imports, and the engine's capability check decides
      // whether it can play.
      issues.warn(`requiredCapabilities[${index}]`, 'unknown-capability', `Unknown capability "${item}".`);
    }
    result.add(item);
  });
  return [...result];
}
