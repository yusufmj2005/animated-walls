export const FRAME_RATE_OPTIONS = [0, 15, 24, 30, 60, 120] as const;
export const RENDER_QUALITY_OPTIONS = ['balanced', 'high', 'maximum'] as const;
export const LOG_LEVEL_OPTIONS = ['debug', 'info', 'warn', 'error'] as const;

export type FrameRateLimit = (typeof FRAME_RATE_OPTIONS)[number];
export type RenderQuality = (typeof RENDER_QUALITY_OPTIONS)[number];
export type LogLevel = (typeof LOG_LEVEL_OPTIONS)[number];

export interface AppSettings {
  launchAtStartup: boolean;
  startMinimized: boolean;
  closeToTray: boolean;
  /** 0 means match each display's refresh rate. */
  frameRateLimit: FrameRateLimit;
  renderQuality: RenderQuality;
  pauseOnBattery: boolean;
  pausePlayback: boolean;
  logLevel: LogLevel;
}

export const DEFAULT_SETTINGS: AppSettings = {
  launchAtStartup: false,
  startMinimized: false,
  closeToTray: true,
  frameRateLimit: 60,
  renderQuality: 'high',
  pauseOnBattery: true,
  pausePlayback: false,
  logLevel: 'info',
};

type Validators = { [K in keyof AppSettings]: (value: unknown) => value is AppSettings[K] };

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const oneOf =
  <T>(options: readonly T[]) =>
  (value: unknown): value is T =>
    options.includes(value as T);

const validators: Validators = {
  launchAtStartup: isBoolean,
  startMinimized: isBoolean,
  closeToTray: isBoolean,
  frameRateLimit: oneOf(FRAME_RATE_OPTIONS),
  renderQuality: oneOf(RENDER_QUALITY_OPTIONS),
  pauseOnBattery: isBoolean,
  pausePlayback: isBoolean,
  logLevel: oneOf(LOG_LEVEL_OPTIONS),
};

export function isSettingKey(key: string): key is keyof AppSettings {
  return Object.prototype.hasOwnProperty.call(validators, key);
}

export function isValidSetting<K extends keyof AppSettings>(key: K, value: unknown): value is AppSettings[K] {
  return validators[key](value);
}
