import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC, isSettingKey, isValidSetting, type AppInfo, type AppSettings, type DisplayAssignmentRecord, type ImportResult, type WallpaperQuery } from '@animated-walls/shared-types';
import type { EngineSupervisor } from '../main/engine/engineSupervisor';
import type { Logger } from '../main/logging/logger';
import type { WallpaperLibrary } from '../main/wallpapers/wallpaperLibrary';

export interface IpcServices {
  isTrustedUrl: (url: string) => boolean;
  logger: Logger;
  library: WallpaperLibrary;
  engine: EngineSupervisor;
  getInfo: () => AppInfo;
  openLogsFolder: () => Promise<void>;
  getSettings: () => AppSettings;
  setSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<AppSettings>;
  importFromDialog: () => Promise<ImportResult>;
  listAssignments: () => DisplayAssignmentRecord[];
  syncAssignments: () => Promise<DisplayAssignmentRecord[]>;
  assign: (displayId: string, wallpaperId: string) => Promise<DisplayAssignmentRecord[]>;
  unassign: (displayId: string) => Promise<DisplayAssignmentRecord[]>;
}

class IpcValidationError extends Error {
  override name = 'IpcValidationError';
}

function requireString(value: unknown, name: string, maxLength = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new IpcValidationError(`${name} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value;
}

function readQuery(value: unknown): WallpaperQuery {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new IpcValidationError('The query must be an object.');
  const { search, type, sort } = value as Record<string, unknown>;
  const query: WallpaperQuery = {};
  if (search !== undefined) {
    if (typeof search !== 'string' || search.length > 200) throw new IpcValidationError('The search text is not valid.');
    query.search = search;
  }
  if (type !== undefined) {
    if (type !== 'all' && type !== 'video' && type !== 'image' && type !== 'web') throw new IpcValidationError('The type filter is not valid.');
    query.type = type;
  }
  if (sort !== undefined) {
    if (sort !== 'recent' && sort !== 'name' && sort !== 'used') throw new IpcValidationError('The sort order is not valid.');
    query.sort = sort;
  }
  return query;
}

/**
 * Registers the closed set of IPC handlers. There is no generic "invoke anything" or
 * "read this file" channel: every call is named, checked against its sender and has its
 * arguments validated, because the renderer is treated as less trusted than this process.
 */
export function registerIpcHandlers(services: IpcServices): void {
  const { logger, library, engine } = services;

  const handle = <Args extends unknown[], Result>(channel: string, handler: (...args: Args) => Result | Promise<Result>): void => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const frameUrl = event.senderFrame?.url ?? '';
      if (!services.isTrustedUrl(frameUrl) || event.senderFrame?.parent) {
        logger.error('app.ipc', 'ipc.untrusted-sender', { channel, frameUrl });
        throw new Error('This request came from an untrusted page.');
      }
      try {
        return await handler(...(args as Args));
      } catch (error) {
        logger.error('app.ipc', 'ipc.handler-failed', { channel, error });
        throw error;
      }
    });
  };

  handle(IPC.appGetInfo, () => services.getInfo());
  handle(IPC.appOpenLogs, () => services.openLogsFolder());

  handle(IPC.settingsGet, () => services.getSettings());
  handle(IPC.settingsSet, (key: unknown, value: unknown) => {
    if (typeof key !== 'string' || !isSettingKey(key)) throw new IpcValidationError(`Unknown setting: ${String(key)}`);
    if (!isValidSetting(key, value)) throw new IpcValidationError(`Invalid value for setting ${key}.`);
    return services.setSetting(key, value);
  });

  handle(IPC.wallpapersList, (query: unknown) => library.list(readQuery(query)));
  handle(IPC.wallpapersImportDialog, () => services.importFromDialog());
  handle(IPC.wallpapersImportPath, (path: unknown) => library.importPath(requireString(path, 'path', 32_767)));
  handle(IPC.wallpapersRemove, async (id: unknown) => {
    await library.remove(requireString(id, 'id', 64));
    await services.syncAssignments();
  });
  handle(IPC.wallpapersAssign, (displayId: unknown, wallpaperId: unknown) =>
    services.assign(requireString(displayId, 'displayId', 512), requireString(wallpaperId, 'wallpaperId', 64)),
  );
  handle(IPC.wallpapersUnassign, (displayId: unknown) => services.unassign(requireString(displayId, 'displayId', 512)));
  handle(IPC.wallpapersListAssignments, () => services.listAssignments());

  handle(IPC.engineGetStatus, () => engine.status);
  handle(IPC.engineGetState, () => engine.state);
  handle(IPC.engineGetCapabilities, () => (engine.status.connection === 'connected' ? engine.call('engine.capabilities') : null));
  handle(IPC.engineGetDiagnostics, () => (engine.status.connection === 'connected' ? engine.call('engine.diagnostics') : null));
  handle(IPC.engineRestart, () => engine.restart());
}
