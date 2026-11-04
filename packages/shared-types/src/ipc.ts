import type {
  DisplayInfo,
  EngineDiagnostics,
  EngineState,
  EngineStatus,
  GpuCapabilities,
} from './engine';
import type { AppSettings } from './settings';

export type WallpaperKind = 'video' | 'image' | 'web';
export type WallpaperSource = 'package' | 'media-file';

export interface WallpaperRecord {
  id: string;
  manifestId: string;
  name: string;
  description: string | null;
  creatorName: string;
  creatorUrl: string | null;
  type: WallpaperKind;
  width: number;
  height: number;
  hasAudio: boolean;
  interactive: boolean;
  source: WallpaperSource;
  formatVersion: number;
  sizeBytes: number;
  importedAt: string;
  lastUsedAt: string | null;
  requiredCapabilities: string[];
  /** Media URL for the preview image, or null when the file has no still preview. */
  previewUrl: string | null;
  /** Media URL for video previews. Web wallpapers never have one. */
  videoUrl: string | null;
}

export interface WallpaperQuery {
  search?: string;
  type?: WallpaperKind | 'all';
  sort?: 'recent' | 'name' | 'used';
}

export interface ImportIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export type ImportResult =
  | { status: 'cancelled' }
  | { status: 'imported'; wallpaper: WallpaperRecord; warnings: ImportIssue[] }
  | { status: 'rejected'; fileName: string; issues: ImportIssue[] };

export interface DisplayAssignmentRecord {
  displayId: string;
  wallpaperId: string;
  updatedAt: string;
}

export interface AppInfo {
  name: string;
  version: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  platform: string;
  isPackaged: boolean;
  userDataPath: string;
}

/** Every call the renderer may make. The preload exposes exactly this, no more. */
export interface AnimatedWallsApi {
  app: {
    getInfo(): Promise<AppInfo>;
    openLogsFolder(): Promise<void>;
  };
  settings: {
    get(): Promise<AppSettings>;
    set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<AppSettings>;
  };
  wallpapers: {
    list(query?: WallpaperQuery): Promise<WallpaperRecord[]>;
    importFromDialog(): Promise<ImportResult>;
    importDroppedFile(file: File): Promise<ImportResult>;
    remove(id: string): Promise<void>;
    assign(displayId: string, wallpaperId: string): Promise<DisplayAssignmentRecord[]>;
    unassign(displayId: string): Promise<DisplayAssignmentRecord[]>;
    listAssignments(): Promise<DisplayAssignmentRecord[]>;
  };
  engine: {
    getStatus(): Promise<EngineStatus>;
    getState(): Promise<EngineState | null>;
    getCapabilities(): Promise<GpuCapabilities | null>;
    getDiagnostics(): Promise<EngineDiagnostics | null>;
    restart(): Promise<void>;
    onStatus(listener: (status: EngineStatus) => void): () => void;
    onState(listener: (state: EngineState) => void): () => void;
  };
  displays: {
    list(): Promise<DisplayInfo[]>;
  };
}

/** Channel names, in one place so main and preload cannot drift apart. */
export const IPC = {
  appGetInfo: 'app:get-info',
  appOpenLogs: 'app:open-logs',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  wallpapersList: 'wallpapers:list',
  wallpapersImportDialog: 'wallpapers:import-dialog',
  wallpapersImportPath: 'wallpapers:import-path',
  wallpapersRemove: 'wallpapers:remove',
  wallpapersAssign: 'wallpapers:assign',
  wallpapersUnassign: 'wallpapers:unassign',
  wallpapersListAssignments: 'wallpapers:list-assignments',
  engineGetStatus: 'engine:get-status',
  engineGetState: 'engine:get-state',
  engineGetCapabilities: 'engine:get-capabilities',
  engineGetDiagnostics: 'engine:get-diagnostics',
  engineRestart: 'engine:restart',
  engineStatusEvent: 'engine:status',
  engineStateEvent: 'engine:state',
} as const;
