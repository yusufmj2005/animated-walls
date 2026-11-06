import type { RenderReason, WallpaperKind } from '@animated-walls/shared-types';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatResolution(width: number, height: number): string {
  return width > 0 && height > 0 ? `${width} × ${height}` : 'Unknown';
}

export const KIND_LABELS: Record<WallpaperKind, string> = { video: 'Video', image: 'Image', web: 'Web' };

export const REASON_LABELS: Record<RenderReason, string> = {
  'desktop-visible': 'Desktop visible',
  'partially-visible': 'Partly visible',
  'no-wallpaper-assigned': 'No wallpaper assigned',
  'gpu-unsupported': 'No supported GPU',
  'desktop-covered': 'Covered by other windows',
  'exclusive-fullscreen': 'Fullscreen app running',
  'session-locked': 'Screen locked',
  'session-disconnected': 'Nobody connected',
  'screen-saver': 'Screen saver running',
  'display-off': 'Display off',
  'system-suspended': 'System asleep',
  'on-battery': 'On battery',
  'user-paused': 'Paused by you',
  'unsupported-wallpaper-type': "This type can't play yet",
  'playback-failed': "This wallpaper couldn't play",
  'no-hardware-decode': 'No GPU decoding for this video',
};
