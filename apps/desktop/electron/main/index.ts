import { join } from 'node:path';
import { BrowserWindow, app, dialog, nativeImage, session, shell } from 'electron';
import { IPC, type AppInfo, type AppSettings, type DisplayAssignment } from '@animated-walls/shared-types';
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
const RENDERER_CRASH_WINDOW_MS = 60_000;
const MAX_RENDERER_CRASHES = 3;

// Only development and test builds may relocate user data. A packaged build ignores this,
// so an environment variable cannot silently point the product at other data.
const overrideUserData = process.env['ANIMATED_WALLS_USER_DATA'];
if (overrideUserData && !app.isPackaged) app.setPath('userData', overrideUserData);
app.setName('Animated Walls');
// Must match appId in electron-builder.yml, or Windows groups the running app apart from its
// pinned shortcut and attributes its tray icon and notifications to Electron.
app.setAppUserModelId('app.animatedwalls.desktop');

registerSchemes();

let mainWindow: BrowserWindow | null = null;
let tray: AppTray | null = null;
let quitting = false;
let appLogger: Logger | null = null;

// Whatever escapes everything else should still leave a record. Without a listener these would
// reach Electron's default handling, and a rejection would vanish without touching the log.
process.on('uncaughtException', (error) => fatal(error));
process.on('unhandledRejection', (reason) => {
  console.error(reason);
  appLogger?.error(LOG_SOURCE, 'app.unhandled-rejection', { error: reason });
});

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
  // Hidden is only safe with a tray icon, or there would be no way to reach the app.
  const startHidden = tray !== null && (process.argv.includes(START_HIDDEN_ARG) || settings.startMinimized);

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
    if (tray && services?.settings.getAll().closeToTray) {
      event.preventDefault();
      window.hide();
      logger.info(LOG_SOURCE, 'window.hidden-to-tray');
    }
  });

  window.on('closed', () => {
    mainWindow = null;
  });

  // Windows does not emit before-quit when logging off or shutting down. Without this the
  // close handler above would hide the window instead of letting the session end.
  window.on('session-end', () => {
    quitting = true;
    logger.info(LOG_SOURCE, 'app.session-end');
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

  const load = (): void => {
    window.loadURL(DEV_SERVER_URL && !app.isPackaged ? DEV_SERVER_URL : `${APP_ORIGIN}/index.html`).catch((error: unknown) => {
      logger.error(LOG_SOURCE, 'window.load-failed', { error });
    });
  };

  const crashes: number[] = [];
  window.webContents.on('render-process-gone', (_event, details) => {
    logger.error(LOG_SOURCE, 'renderer.gone', { reason: details.reason, exitCode: details.exitCode });
    if (details.reason === 'clean-exit' || quitting || window.isDestroyed()) return;

    // Reload, unless it keeps crashing, which reloading would just turn into an endless loop.
    const now = Date.now();
    crashes.push(now);
    while (crashes[0] !== undefined && now - crashes[0] > RENDERER_CRASH_WINDOW_MS) crashes.shift();
    if (crashes.length >= MAX_RENDERER_CRASHES) {
      logger.error(LOG_SOURCE, 'renderer.gave-up', { crashes: crashes.length });
      dialog.showErrorBox('Animated Walls keeps crashing', `The window crashed ${crashes.length} times in a row, so it was not reloaded again. Restart the app, and if this continues, the details are in its logs folder.`);
      return;
    }
    logger.info(LOG_SOURCE, 'renderer.reloading');
    load();
  });
  window.on('unresponsive', () => logger.warn(LOG_SOURCE, 'renderer.unresponsive'));
  window.on('responsive', () => logger.info(LOG_SOURCE, 'renderer.responsive'));

  load();
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
  appLogger = logger;
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
  // Without this, a page asking whether it has a permission is told yes by default.
  session.defaultSession.setPermissionCheckHandler(() => false);

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
  });
  await library.initialise();

  const initialSettings = settingsRepository.getAll();
  logger.setLevel(initialSettings.logLevel);

  /** Assignments with the files behind them, as the engine needs them. */
  const engineAssignments = (): DisplayAssignment[] =>
    wallpaperRepository.listAssignments().flatMap(({ displayId, wallpaperId }) => {
      const source = library.playbackSource(wallpaperId);
      return source ? [{ displayId, wallpaperId, ...source }] : [];
    });

  const pushPlayback = async (engine: EngineSupervisor): Promise<void> => {
    const current = settingsRepository.getAll();
    await engine.call('diagnostics.setLogLevel', { level: current.logLevel });
    await engine.call('playback.configure', {
      frameRateLimit: current.frameRateLimit,
      quality: current.renderQuality,
      pauseOnBattery: current.pauseOnBattery,
    });
    await engine.call('playback.setPaused', { paused: current.pausePlayback });
    await engine.call('playback.setAssignments', { assignments: engineAssignments() });
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
  engine.on('gpu', (gpu) => broadcast(IPC.engineGpuEvent, gpu));

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

  /**
   * Passes a saved change to the engine. The database is the source of truth and everything
   * is re-sent on reconnection, so a failure here must not report the save itself as failed.
   */
  const tellEngine = async (what: string, call: () => Promise<unknown>): Promise<void> => {
    if (engine.status.connection !== 'connected') return;
    try {
      await call();
    } catch (error) {
      logger.warn(LOG_SOURCE, 'engine.update-failed', { what, error });
    }
  };

  const setSetting = async <K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<AppSettings> => {
    const next = settingsRepository.set(key, value);
    logger.info(LOG_SOURCE, 'settings.changed', { key, value });

    if (key === 'launchAtStartup') applyLoginItem(value as boolean);
    if (key === 'logLevel') logger.setLevel(next.logLevel);
    if (key === 'pausePlayback') tray?.refreshMenu();
    // The tray changes settings too, so the UI cannot rely on its own call's result.
    broadcast(IPC.settingsChangedEvent, next);

    if (key === 'logLevel') await tellEngine(key, () => engine.call('diagnostics.setLogLevel', { level: next.logLevel }));
    if (key === 'pausePlayback') await tellEngine(key, () => engine.call('playback.setPaused', { paused: next.pausePlayback }));
    if (key === 'frameRateLimit' || key === 'renderQuality' || key === 'pauseOnBattery') {
      await tellEngine(key, () => engine.call('playback.configure', { frameRateLimit: next.frameRateLimit, quality: next.renderQuality, pauseOnBattery: next.pauseOnBattery }));
    }
    return next;
  };

  const syncAssignments = async (): Promise<ReturnType<WallpaperRepository['listAssignments']>> => {
    const assignments = wallpaperRepository.listAssignments();
    await tellEngine('assignments', () => engine.call('playback.setAssignments', { assignments: engineAssignments() }));
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
    syncAssignments,
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

  // The app still works without a tray icon, it just cannot hide to one.
  try {
    tray = new AppTray({
      iconPath: resourcePath('icons', 'tray.png'),
      showWindow,
      isPaused: () => settingsRepository.getAll().pausePlayback,
      setPaused: (paused) => {
        setSetting('pausePlayback', paused).catch((error: unknown) => logger.error(LOG_SOURCE, 'tray.pause-failed', { error }));
      },
      quit: () => app.quit(),
    });
    logger.info(LOG_SOURCE, 'tray.created');
  } catch (error) {
    logger.error(LOG_SOURCE, 'tray.unavailable', { error });
  }

  mainWindow = createWindow(initialSettings, logger);
  await engine.start();
}

function fatal(error: unknown): void {
  console.error(error);
  appLogger?.error(LOG_SOURCE, 'app.fatal', { error });
  dialog.showErrorBox('Animated Walls failed to start', error instanceof Error ? error.message : String(error));
  app.exit(1);
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(bootstrap).catch(fatal);

  // With the tray option on, the app stays alive with no windows until an explicit quit.
  app.on('window-all-closed', () => {
    if (quitting || !tray || !services?.settings.getAll().closeToTray) app.quit();
  });

  let shutdownStarted = false;
  let shutdownComplete = false;
  app.on('before-quit', (event) => {
    quitting = true;
    if (shutdownComplete || !services) return;
    event.preventDefault();

    // A second quit while the first is under way must not close the database twice.
    if (shutdownStarted) return;
    shutdownStarted = true;

    const { logger, engine, closeDatabase } = services;
    logger.info(LOG_SOURCE, 'app.quit-requested');
    tray?.destroy();
    tray = null;

    engine
      .shutdown()
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
