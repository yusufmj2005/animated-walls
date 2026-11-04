import { useState } from 'react';
import { Badge, cx } from '@animated-walls/design-system';
import type { WallpaperRecord } from '@animated-walls/shared-types';
import { KIND_LABELS } from '../services/format';
import { WallpaperArt } from './WallpaperArt';

export function WallpaperCard({ wallpaper, selected, assigned, onSelect }: { wallpaper: WallpaperRecord; selected?: boolean; assigned?: boolean; onSelect: (wallpaper: WallpaperRecord) => void }) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      type="button"
      onClick={() => onSelect(wallpaper)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      aria-pressed={selected}
      data-testid="wallpaper-card"
      className={cx(
        'group block w-full cursor-pointer overflow-hidden rounded-card border bg-surface text-left transition-[border-color,transform,box-shadow] duration-200 ease-out hover:-translate-y-0.5 hover:shadow-[0_10px_30px_rgb(0_0_0/0.35)]',
        selected ? 'border-accent' : 'border-line hover:border-line-strong',
      )}
    >
      <div className="relative">
        <WallpaperArt wallpaper={wallpaper} playing={hovered} className="preview-frame" />
        {assigned && (
          <Badge tone="accent" className="absolute top-2 left-2 backdrop-blur-md">
            On display
          </Badge>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-medium text-ink">{wallpaper.name}</div>
          <div className="truncate text-xs text-ink-3">{wallpaper.creatorName}</div>
        </div>
        <Badge>{KIND_LABELS[wallpaper.type]}</Badge>
      </div>
    </button>
  );
}
