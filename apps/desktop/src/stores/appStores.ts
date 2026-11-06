import { DEFAULT_SETTINGS, type AppSettings, type DisplayAssignmentRecord, type EngineState, type EngineStatus, type GpuCapabilities, type ImportIssue, type WallpaperRecord } from '@animated-walls/shared-types';
import { api, errorMessage } from '../services/api';
import { createStore } from './createStore';

export const engineStatusStore = createStore<EngineStatus>({ connection: 'stopped', health: null, lastError: null, restarts: 0 });
export const engineStateStore = createStore<EngineState | null>(null);
export const gpuStore = createStore<GpuCapabilities | null>(null);
export const settingsStore = createStore<AppSettings>(DEFAULT_SETTINGS);
export const wallpapersStore = createStore<WallpaperRecord[]>([]);
export const assignmentsStore = createStore<DisplayAssignmentRecord[]>([]);

export interface Notice {
  id: number;
  tone: 'ok' | 'bad' | 'warn';
  title: string;
  detail?: string;
  issues?: ImportIssue[];
}
export const noticesStore = createStore<Notice[]>([]);

let nextNoticeId = 1;

export function notify(notice: Omit<Notice, 'id'>): void {
  const id = nextNoticeId++;
  noticesStore.set((current) => [...current, { ...notice, id }]);
  // Rejections carry detail worth reading, so they stay until dismissed.
  if (notice.tone === 'ok') setTimeout(() => dismissNotice(id), 4000);
}

export function dismissNotice(id: number): void {
  noticesStore.set((current) => current.filter((notice) => notice.id !== id));
}

export async function refreshWallpapers(): Promise<void> {
  wallpapersStore.set(await api.wallpapers.list({ sort: 'recent' }));
  assignmentsStore.set(await api.wallpapers.listAssignments());
}

export async function refreshEngine(): Promise<void> {
  const status = await api.engine.getStatus();
  engineStatusStore.set(status);
  engineStateStore.set(await api.engine.getState());
  if (status.connection === 'connected') gpuStore.set(await api.engine.getCapabilities());
}

export async function changeSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void> {
  try {
    settingsStore.set(await api.settings.set(key, value));
  } catch (error) {
    notify({ tone: 'bad', title: 'The setting could not be saved', detail: errorMessage(error) });
  }
}

export function reportFailure(title: string, error: unknown): void {
  notify({ tone: 'bad', title, detail: errorMessage(error) });
}

let started = false;

/** Loads initial data and subscribes to live engine updates, once. */
export function startStores(): void {
  if (started) return;
  started = true;

  api.engine.onStatus((status) => {
    const wasConnected = engineStatusStore.get().connection === 'connected';
    engineStatusStore.set(status);
    // Everything the engine reported is out of date the moment it stops.
    if (status.connection !== 'connected') engineStateStore.set(null);
    if (status.connection === 'connected' && !wasConnected) {
      refreshEngine().catch((error: unknown) => reportFailure('The engine status could not be read', error));
    }
  });
  api.engine.onState((state) => engineStateStore.set(state));
  api.settings.onChanged((settings) => settingsStore.set(settings));

  // Updates pause while the window is hidden, so catch up when it returns.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshEngine().catch((error: unknown) => reportFailure('The engine status could not be read', error));
      api.settings.get().then((settings) => settingsStore.set(settings)).catch((error: unknown) => reportFailure('Settings could not be read', error));
    }
  });

  Promise.all([api.settings.get().then((value) => settingsStore.set(value)), refreshWallpapers(), refreshEngine()]).catch((error: unknown) =>
    reportFailure('Animated Walls could not load its data', error),
  );
}
