import { Menu, Tray, nativeImage } from 'electron';
import type { EngineStatus } from '@animated-walls/shared-types';

export interface TrayActions {
  iconPath: string;
  showWindow: () => void;
  isPaused: () => boolean;
  setPaused: (paused: boolean) => void;
  quit: () => void;
}

const CONNECTION_LABELS: Record<EngineStatus['connection'], string> = {
  connected: 'Engine running',
  starting: 'Engine starting…',
  restarting: 'Engine restarting…',
  stopped: 'Engine stopped',
  failed: 'Engine failed',
};

export class AppTray {
  private readonly tray: Tray;
  private status: EngineStatus['connection'] = 'stopped';

  constructor(private readonly actions: TrayActions) {
    const icon = nativeImage.createFromPath(actions.iconPath);
    if (icon.isEmpty()) throw new Error(`The tray icon could not be loaded from ${actions.iconPath}.`);
    this.tray = new Tray(icon);
    this.tray.setToolTip('Animated Walls');
    this.tray.on('click', () => actions.showWindow());
    this.refreshMenu();
  }

  updateEngineStatus(status: EngineStatus): void {
    if (status.connection === this.status) return;
    this.status = status.connection;
    this.tray.setToolTip(`Animated Walls: ${CONNECTION_LABELS[status.connection]}`);
    this.refreshMenu();
  }

  refreshMenu(): void {
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Animated Walls', click: () => this.actions.showWindow() },
        { label: CONNECTION_LABELS[this.status], enabled: false },
        { type: 'separator' },
        {
          label: 'Pause wallpapers',
          type: 'checkbox',
          checked: this.actions.isPaused(),
          click: (item) => this.actions.setPaused(item.checked),
        },
        { type: 'separator' },
        { label: 'Quit', click: () => this.actions.quit() },
      ]),
    );
  }

  destroy(): void {
    this.tray.destroy();
  }
}
