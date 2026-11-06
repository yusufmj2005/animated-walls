import { useMemo, useState } from 'react';
import { Badge, Card, DisplayIcon, EmptyState, KeyValue, PageHeader, Select, cx } from '@animated-walls/design-system';
import type { DisplayInfo, Rect } from '@animated-walls/shared-types';
import { DecisionBadge, VisibilityBadge } from '../components/EngineSummary';
import { WallpaperArt } from '../components/WallpaperArt';
import { api } from '../services/api';
import { REASON_LABELS } from '../services/format';
import { assignmentsStore, engineStateStore, engineStatusStore, refreshWallpapers, reportFailure, wallpapersStore } from '../stores/appStores';
import { useStore } from '../stores/createStore';

const MAP_MAX_HEIGHT = 220;
// Narrow enough to fit at the window's minimum width, so a wide monitor row never overflows.
const MAP_MAX_WIDTH = 600;

function boundsOf(displays: readonly DisplayInfo[]): Rect {
  const left = Math.min(...displays.map((display) => display.bounds.x));
  const top = Math.min(...displays.map((display) => display.bounds.y));
  const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width));
  const bottom = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function DisplayMap({ displays, selectedId, onSelect }: { displays: readonly DisplayInfo[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const state = useStore(engineStateStore);
  const assignments = useStore(assignmentsStore);
  const wallpapers = useStore(wallpapersStore);

  const area = useMemo(() => boundsOf(displays), [displays]);
  const scale = Math.min(MAP_MAX_HEIGHT / area.height, MAP_MAX_WIDTH / area.width);

  return (
    <div className="flex justify-center rounded-card border border-line bg-surface px-6 py-8">
      <div className="relative" style={{ width: area.width * scale, height: area.height * scale }}>
        {displays.map((display, index) => {
          const wallpaperId = assignments.find((item) => item.displayId === display.id)?.wallpaperId;
          const wallpaper = wallpapers.find((item) => item.id === wallpaperId);
          const visibility = state?.visibility.find((item) => item.displayId === display.id);
          return (
            <button
              key={display.id}
              type="button"
              onClick={() => onSelect(display.id)}
              aria-pressed={display.id === selectedId}
              style={{
                left: (display.bounds.x - area.x) * scale,
                top: (display.bounds.y - area.y) * scale,
                width: display.bounds.width * scale - 4,
                height: display.bounds.height * scale - 4,
              }}
              className={cx(
                'absolute cursor-pointer overflow-hidden rounded-[6px] border-2 bg-raised transition-colors duration-150',
                display.id === selectedId ? 'border-accent' : 'border-line-strong hover:border-ink-3',
              )}
            >
              {wallpaper && (
                <div className={cx('absolute inset-0', visibility?.state === 'covered' && 'opacity-50')}>
                  <WallpaperArt key={wallpaper.id} wallpaper={wallpaper} className="size-full" />
                </div>
              )}
              <span className="absolute top-2 left-2 flex size-6 items-center justify-center rounded-full bg-black/60 text-xs font-semibold text-white">{index + 1}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function DisplaysPage() {
  const state = useStore(engineStateStore);
  const status = useStore(engineStatusStore);
  const assignments = useStore(assignmentsStore);
  const wallpapers = useStore(wallpapersStore);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const displays = state?.displays ?? [];
  const selected = displays.find((display) => display.id === selectedId) ?? displays[0] ?? null;
  const rendererImplemented = status.health?.rendererImplemented ?? false;

  const assign = async (displayId: string, wallpaperId: string): Promise<void> => {
    try {
      if (wallpaperId) await api.wallpapers.assign(displayId, wallpaperId);
      else await api.wallpapers.unassign(displayId);
      await refreshWallpapers();
    } catch (error) {
      reportFailure('The assignment could not be saved', error);
    }
  };

  if (displays.length === 0) {
    return (
      <div className="mx-auto max-w-6xl animate-page px-8 py-7">
        <PageHeader title="Displays" />
        <Card>
          <EmptyState icon={<DisplayIcon size={22} />} title="No displays to show">
            {status.connection === 'connected' ? 'Windows did not report any displays.' : 'Displays are read by the engine, which is not running right now.'}
          </EmptyState>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl animate-page px-8 py-7">
      <PageHeader title="Displays" description={`${displays.length} connected · Each display is watched and suspended independently.`} />
      <DisplayMap displays={displays} selectedId={selected?.id ?? null} onSelect={setSelectedId} />

      <div className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] gap-4" data-testid="display-list">
        {displays.map((display, index) => {
          const visibility = state?.visibility.find((item) => item.displayId === display.id);
          const render = state?.render.find((item) => item.displayId === display.id);
          const wallpaperId = assignments.find((item) => item.displayId === display.id)?.wallpaperId ?? '';
          return (
            <Card key={display.id} className={cx('p-4 transition-colors', display.id === selected?.id && 'border-line-strong')}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-raised text-xs font-semibold text-ink-2">{index + 1}</span>
                  <h2 className="truncate font-display text-[15px] font-semibold text-ink" data-testid="display-name">
                    {display.friendlyName}
                  </h2>
                </div>
                {display.isPrimary && <Badge>Primary</Badge>}
              </div>

              <dl className="m-0 mt-2 divide-y divide-line">
                <KeyValue label="Resolution">
                  {display.bounds.width} × {display.bounds.height}
                </KeyValue>
                <KeyValue label="Refresh rate">{display.refreshRateHz} Hz</KeyValue>
                <KeyValue label="Scale">{display.scalePercent}%</KeyValue>
                <KeyValue label="Visibility">{visibility ? <VisibilityBadge state={visibility.state} fraction={visibility.visibleFraction} /> : '—'}</KeyValue>
                <KeyValue label="Decision">
                  {render ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="text-xs text-ink-3">{REASON_LABELS[render.reason]}</span>
                      <DecisionBadge decision={render.decision} rendererImplemented={rendererImplemented} />
                    </span>
                  ) : (
                    '—'
                  )}
                </KeyValue>
              </dl>

              <label className="mt-3 flex items-center justify-between gap-3 text-[13px] text-ink-2">
                Wallpaper
                <Select className="min-w-0 flex-1" value={wallpaperId} onChange={(event) => void assign(display.id, event.target.value)} data-testid="display-assignment">
                  <option value="">None</option>
                  {wallpapers.map((wallpaper) => (
                    <option key={wallpaper.id} value={wallpaper.id}>
                      {wallpaper.name}
                    </option>
                  ))}
                </Select>
              </label>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
