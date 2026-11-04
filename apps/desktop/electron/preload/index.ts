import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC, type AnimatedWallsApi } from '@animated-walls/shared-types';

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  // The IpcRendererEvent is dropped because it exposes `sender`, which would give the
  // page a route back to ipcRenderer.
  const wrapped = (_event: unknown, value: T): void => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: AnimatedWallsApi = {
  app: {
    getInfo: () => ipcRenderer.invoke(IPC.appGetInfo),
    openLogsFolder: () => ipcRenderer.invoke(IPC.appOpenLogs),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (key, value) => ipcRenderer.invoke(IPC.settingsSet, key, value),
  },
  wallpapers: {
    list: (query) => ipcRenderer.invoke(IPC.wallpapersList, query),
    importFromDialog: () => ipcRenderer.invoke(IPC.wallpapersImportDialog),
    importDroppedFile: (file) => ipcRenderer.invoke(IPC.wallpapersImportPath, webUtils.getPathForFile(file)),
    remove: (id) => ipcRenderer.invoke(IPC.wallpapersRemove, id),
    assign: (displayId, wallpaperId) => ipcRenderer.invoke(IPC.wallpapersAssign, displayId, wallpaperId),
    unassign: (displayId) => ipcRenderer.invoke(IPC.wallpapersUnassign, displayId),
    listAssignments: () => ipcRenderer.invoke(IPC.wallpapersListAssignments),
  },
  engine: {
    getStatus: () => ipcRenderer.invoke(IPC.engineGetStatus),
    getState: () => ipcRenderer.invoke(IPC.engineGetState),
    getCapabilities: () => ipcRenderer.invoke(IPC.engineGetCapabilities),
    getDiagnostics: () => ipcRenderer.invoke(IPC.engineGetDiagnostics),
    restart: () => ipcRenderer.invoke(IPC.engineRestart),
    onStatus: (listener) => subscribe(IPC.engineStatusEvent, listener),
    onState: (listener) => subscribe(IPC.engineStateEvent, listener),
  },
};

contextBridge.exposeInMainWorld('animatedWalls', api);
