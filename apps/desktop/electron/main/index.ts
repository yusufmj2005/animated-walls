import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, app, dialog, nativeImage, session, shell } from 'electron';
import { IPC, type AppInfo, type AppSettings } from '@animated-walls/shared-types';
import { registerIpcHandlers } from '../ipc/register';
import { openDatabase } from './database/database';
import { SettingsRepository } from './database/settingsRepository';
import { WallpaperRepository } from './database/wallpaperRepository';
import { EngineSupervisor } from './engine/engineSupervisor';
import { Logger } from './logging/logger';
import { APP_HOST, APP_ORIGIN, APP_SCHEME, registerAppProtocol, registerMediaProtocol, registerSchemes } from './protocols';
import { AppTray } from './tray';
import { IMPORTABLE_EXTENSIONS, WallpaperLibrary } from './wallpapers/wallpaperLibrary';

const LOG_SOURCE = 'app.main';
const WINDOW_BACKGROUND = '#0a0b0e';
const TITLE_BAR_HEIGHT = 40;
const DEV_SERVER_URL = process.env['ELECTRON_RENDERER_URL'];
const START_HIDDEN_ARG = '--start-hidden';

// Only development and test builds may relocate user data. A packaged build ignores this,
// so an environment variable cannot silently point the product at other data.
const overrideUserData = process.env['ANIMATED_WALLS_USER_DATA'];
if (overrideUserData && !app.isPackaged) app.setPath('userData', overrideUserData);
app.setName('Animated Walls');

registerSchemes();

let mainWindow: BrowserWindow | null = null;
let tray: AppTray | null = null;
let quitting = false;

function isTrustedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (DEV_SERVER_URL && !app.isPackaged && parsed.origin === new URL(DEV_SERVER_URL).origin) return true;
    // Not parsed.origin: for a custom scheme the URL standard gives the opaque origin "null".
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST;
  } catch {
    return false;
  }
}

function resourcePath(...segments: string[]): string {
  return app.isPackaged ? join(process.resourcesPath, ...segments) : join(app.getAppPath(), 'resources', ...segments);
}

function createWindow(settings: AppSettings, logger: Logger): BrowserWindow {
  const startHidden = process.argv.includes(START_HIDDEN_ARG) || settings.startMinimized;

  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    show: false,
    title: 'Animated Walls',
    backgroundColor: WINDOW_BACKGROUND,
    icon: nativeImage.createFromPath(resourcePath('icons', 'app.ico')),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: WINDOW_BACKGROUND, symbolColor: '#a3a9b5', height: TITLE_BAR_HEIGHT },
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => {
    if (!startHidden) window.show();
    logger.info(LOG_SOURCE, 'window.ready', { startHidden });
  });

  window.on('close', (event) => {
    if (quitting) return;
    // Read fresh, because the setting can change while the window is open.
    if (services?.settings.getAll().closeToTray) {
      event.preventDefault();
      window.hide();
      logger.info(LOG_SOURCE, 'window.hidden-to-tray');
    }
  });

  window.on('closed', () => {
    mainWindow = null;
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    logger.warn(LOG_SOURCE, 'window.open-blocked', { url });
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) {
      event.preventDefault();
      logger.warn(LOG_SOURCE, 'navigation.blocked', { url });
    }
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    logger.error(LOG_SOURCE, 'renderer.gone', { reason: details.reason, exitCode: details.exitCode });
  });

  if (DEV_SERVER_URL && !app.isPackaged) {
    void window.loadURL(DEV_SERVER_URL);
  } else {
    void window.loadURL(`${APP_ORIGIN}/index.html`);
  }
  return window;
}

function showWindow(): void {
  if (!mainWindow && services) mainWindow = createWindow({ ...services.settings.getAll(), startMinimized: false }, services.logger);
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function broadcast(channel: string, payload: unknown): void {
  // A hidden window needs no updates. The renderer re-reads state when it is shown.
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    mainWindow.webContents.send(channel, payload);
  }
}

interface Services {
  logger: Logger;
  settings: SettingsRepository;
  wallpapers: WallpaperRepository;
  library: WallpaperLibrary;
  engine: EngineSupervisor;
  closeDatabase: () => void;
}

let services: Services | null = null;

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData');
  const logDirectory = join(userData, 'logs');
  const logger = new Logger({ directory: logDirectory, fileName: 'app.log' });
  logger.info(LOG_SOURCE, 'app.start', {
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    packaged: app.isPackaged,
  });

  // Read only after this event. Before the GPU process reports in, getGPUFeatureStatus says
  // "disabled_software" for everything, even on a fully working GPU.
  app.once('gpu-info-update', () => {
    const features = app.getGPUFeatureStatus();
    const hardware = features.gpu_compositing === 'enabled';
    logger[hardware ? 'info' : 'warn'](LOG_SOURCE, 'ui.gpu-status', { compositing: features.gpu_compositing, videoDecode: features.video_decode, webgl: features.webgl });
  });
  app.on('child-process-gone', (_event, details) => {
    if (details.type === 'GPU') logger.error(LOG_SOURCE, 'ui.gpu-process-gone', { reason: details.reason, exitCode: details.exitCode });
  });

  // No page in this app needs a browser permission, so all are refused.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    logger.warn(LOG_SOURCE, 'permission.denied', { permission });
    callback(false);
  });

  let opened;
  try {
    opened = openDatabase(join(userData, 'animated-walls.db'));
  } catch (error) {
    logger.error(LOG_SOURCE, 'database.open-failed', { error });
    dialog.showErrorBox(
      'Animated Walls could not open its database',
      `${error instanceof Error ? error.message : String(error)}\n\nYour data has not been changed. Details are in:\n${logDirectory}`,
    );
    app.exit(1);
    return;
  }
  const { db, migration } = opened;
  logger.info(LOG_SOURCE, 'database.ready', { from: migration.from, to: migration.to, applied: migration.applied });

  const settingsRepository = new SettingsRepository(db, logger);
  const wallpaperRepository = new WallpaperRepository(db);
  const library = new WallpaperLibrary({
    root: join(userData, 'wallpapers'),
    repository: wallpaperRepository,
    logger,
    measureImage: (path) => {
      const size = nativeImage.createFromPath(path).getSize();
      return size.width > 0 ? size : null;
    },
  });
  await library.initialise();
  const orphans = await library.findOrphans();
  if (orphans.length > 0) logger.warn(LOG_SOURCE, 'library.orphan-directories', { count: orphans.length, ids: orphans });

  const initialSettings = settingsRepository.getAll();
  logger.setLevel(initialSettings.logLevel);

  const pushPlayback = async (engine: EngineSupervisor): Promise<void> => {
    const current = settingsRepository.getAll();
    await engine.call('diagnostics.setLogLevel', { level: current.logLevel });
    await engine.call('playback.configure', {
      frameRateLimit: current.frameRateLimit,
      quality: current.renderQuality,
      pauseOnBattery: current.pauseOnBattery,
    });
    await engine.call('playback.setPaused', { paused: current.pausePlayback });
    await engine.call('playback.setAssignments', {
      assignments: wallpaperRepository.listAssignments().map(({ displayId, wallpaperId }) => ({ displayId, wallpaperId })),
    });
  };

  const engine = new EngineSupervisor({
    enginePath: resourcePath('engine', 'AnimatedWalls.Engine.exe'),
    logDirectory,
    logLevel: initialSettings.logLevel,
    logger,
    onConnected: pushPlayback,
  });
  engine.on('status', (status) => {
    tray?.updateEngineStatus(status);
    broadcast(IPC.engineStatusEvent, status);
  });
  engine.on('state', (state) => broadcast(IPC.engineStateEvent, state));

  services = {
    logger,
    settings: settingsRepository,
    wallpapers: wallpaperRepository,
    library,
    engine,
    closeDatabase: () => db.close(),
  };

  const applyLoginItem = (enabled: boolean): void => {
    // An unpackaged build would register the bare electron.exe, which opens nothing useful.
    if (!app.isPackaged) {
      logger.info(LOG_SOURCE, 'login-item.skipped-in-development', { enabled });
      return;
    }
    app.setLoginItemSettings({ openAtLogin: enabled, args: [START_HIDDEN_ARG] });
    logger.info(LOG_SOURCE, 'login-item.updated', { enabled });
  };
  applyLoginItem(initialSettings.launchAtStartup);

  const setSetting = async <K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<AppSettings> => {
    const next = settingsRepository.set(key, value);
    logger.info(LOG_SOURCE, 'settings.changed', { key, value });

    if (key === 'launchAtStartup') applyLoginItem(value as boolean);
    if (key === 'logLevel') logger.setLevel(next.logLevel);
    if (key === 'pausePlayback') tray?.refreshMenu();

    if (engine.status.connection === 'connected') {
      if (key === 'logLevel') await engine.call('diagnostics.setLogLevel', { level: next.logLevel });
      if (key === 'pausePlayback') await engine.call('playback.setPaused', { paused: next.pausePlayback });
      if (key === 'frameRateLimit' || key === 'renderQuality' || key === 'pauseOnBattery') {
        await engine.call('playback.configure', { frameRateLimit: next.frameRateLimit, quality: next.renderQuality, pauseOnBattery: next.pauseOnBattery });
      }
    }
    return next;
  };

  const syncAssignments = async (): Promise<ReturnType<WallpaperRepository['listAssignments']>> => {
    const assignments = wallpaperRepository.listAssignments();
    if (engine.status.connection === 'connected') {
      await engine.call('playback.setAssignments', { assignments: assignments.map(({ displayId, wallpaperId }) => ({ displayId, wallpaperId })) });
    }
    return assignments;
  };

  registerAppProtocol(join(import.meta.dirname, '../renderer'), logger);
  registerMediaProtocol(library, logger);

  registerIpcHandlers({
    isTrustedUrl,
    logger,
    library,
    engine,
    getSettings: () => settingsRepository.getAll(),
    setSetting,
    getInfo: (): AppInfo => ({
      name: 'Animated Walls',
      version: app.getVersion(),
      electronVersion: process.versions.electron ?? '',
      chromeVersion: process.versions.chrome ?? '',
      nodeVersion: process.versions.node,
      platform: `${process.platform} ${process.getSystemVersion()}`,
      isPackaged: app.isPackaged,
      userDataPath: userData,
    }),
    openLogsFolder: async () => {
      const failure = await shell.openPath(logDirectory);
      if (failure) throw new Error(failure);
    },
    importFromDialog: async () => {
      const options = {
        title: 'Import wallpaper',
        properties: ['openFile'] as 'openFile'[],
        filters: [{ name: 'Wallpapers', extensions: IMPORTABLE_EXTENSIONS }],
      };
      const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
      const path = result.filePaths[0];
      if (result.canceled || !path) return { status: 'cancelled' as const };
      return library.importPath(path);
    },
    listAssignments: () => wallpaperRepository.listAssignments(),
    assign: async (displayId, wallpaperId) => {
      if (!wallpaperRepository.find(wallpaperId)) throw new Error('That wallpaper is no longer in the library.');
      wallpaperRepository.assign(displayId, wallpaperId);
      return syncAssignments();
    },
    unassign: async (displayId) => {
      wallpaperRepository.unassign(displayId);
      return syncAssignments();
    },
  });

  const trayIcon = resourcePath('icons', 'tray.png');
  if (existsSync(trayIcon)) {
    tray = new AppTray({
      iconPath: trayIcon,
      showWindow,
      isPaused: () => settingsRepository.getAll().pausePlayback,
      setPaused: (paused) => {
        setSetting('pausePlayback', paused).catch((error: unknown) => logger.error(LOG_SOURCE, 'tray.pause-failed', { error }));
      },
      quit: () => app.quit(),
    });
    logger.info(LOG_SOURCE, 'tray.created');
  } else {
    logger.error(LOG_SOURCE, 'tray.icon-missing', { path: trayIcon });
  }

  mainWindow = createWindow(initialSettings, logger);
  await engine.start();
}

function fatal(error: unknown): void {
  console.error(error);
  services?.logger.error(LOG_SOURCE, 'app.fatal', { error });
  dialog.showErrorBox('Animated Walls failed to start', error instanceof Error ? error.message : String(error));
  app.exit(1);
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(bootstrap).catch(fatal);

  // The tray keeps the app alive with no windows. Only an explicit quit ends it.
  app.on('window-all-closed', () => {
    if (quitting || !tray) app.quit();
  });

  let shutdownComplete = false;
  app.on('before-quit', (event) => {
    quitting = true;
    if (shutdownComplete || !services) return;
    event.preventDefault();

    const { logger, engine, closeDatabase } = services;
    logger.info(LOG_SOURCE, 'app.quit-requested');
    tray?.destroy();
    tray = null;

    engine
      .stop()
      .catch((error: unknown) => logger.error(LOG_SOURCE, 'engine.stop-failed', { error }))
      .finally(() => {
        closeDatabase();
        logger.info(LOG_SOURCE, 'app.shutdown');
        logger.close();
        shutdownComplete = true;
        app.quit();
      });
  });
}
