import { Badge, Button, Card, EmptyState, KeyValue, PageHeader, PlusIcon, SectionTitle, SparkIcon, WarningIcon } from '@animated-walls/design-system';
import { DecisionBadge, EngineConnectionBadge, VisibilityBadge } from '../components/EngineSummary';
import { WallpaperArt } from '../components/WallpaperArt';
import { WallpaperCard } from '../components/WallpaperCard';
import { useImport } from '../hooks/useImport';
import type { PageId } from '../layouts/AppLayout';
import { REASON_LABELS, formatBytes } from '../services/format';
import { assignmentsStore, engineStateStore, engineStatusStore, gpuStore, wallpapersStore } from '../stores/appStores';
import { useStore } from '../stores/createStore';

// Clearly placeholder content: the marketplace backend does not exist yet.
const FEATURED_PLACEHOLDERS = [
  { title: 'Slow Motion', gradient: 'linear-gradient(135deg,#1c2a4a,#3f5fa8 55%,#9fb4ff)' },
  { title: 'After Dark', gradient: 'linear-gradient(135deg,#17131f,#3b2352 60%,#8d4f8f)' },
  { title: 'Natural Light', gradient: 'linear-gradient(135deg,#10231d,#1e5a4a 55%,#7ec9a1)' },
];

export function HomePage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const wallpapers = useStore(wallpapersStore);
  const assignments = useStore(assignmentsStore);
  const status = useStore(engineStatusStore);
  const state = useStore(engineStateStore);
  const gpu = useStore(gpuStore);
  const { importFromDialog, importing } = useImport();

  const primary = state?.displays.find((display) => display.isPrimary) ?? state?.displays[0] ?? null;
  const primaryVisibility = state?.visibility.find((item) => item.displayId === primary?.id);
  const primaryRender = state?.render.find((item) => item.displayId === primary?.id);
  // The database knows the assignment even when the engine, which knows the displays, is down.
  // That must not read as if nothing were assigned.
  const assignedId = primary ? assignments.find((item) => item.displayId === primary.id)?.wallpaperId : assignments[0]?.wallpaperId;
  const current = wallpapers.find((item) => item.id === assignedId) ?? null;
  const assignedIds = new Set(assignments.map((item) => item.wallpaperId));

  const recent = [...wallpapers]
    .filter((item) => item.lastUsedAt)
    .sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))
    .slice(0, 4);

  const gpuUnsupported = gpu?.status === 'unsupported';

  return (
    <div className="mx-auto max-w-6xl animate-page px-8 py-7">
      <PageHeader title="Home" />

      {gpuUnsupported && (
        <div className="mb-5 flex items-start gap-3 rounded-card border border-bad/30 bg-bad-soft p-4" role="alert">
          <WarningIcon className="mt-0.5 shrink-0 text-bad" />
          <div className="text-[13.5px]">
            <div className="font-medium text-ink">Wallpaper playback is unavailable on this PC</div>
            <div className="mt-0.5 text-ink-2">{gpu?.unsupportedReasons.join(' ')}</div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-5">
        <section aria-label="Current wallpaper" className="relative overflow-hidden rounded-hero border border-line bg-surface">
          {current ? (
            <>
              {/* Keyed, so a preview that failed to load does not stay failed for the next one. */}
              <WallpaperArt key={current.id} wallpaper={current} className="preview-frame w-full" />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-5 pt-16 pb-4">
                <div className="text-xs font-medium tracking-wide text-white/70">Current wallpaper</div>
                <div className="mt-0.5 font-display text-2xl font-semibold text-white">{current.name}</div>
                <div className="text-[13px] text-white/75">
                  {current.creatorName}
                  {primary ? ` · ${primary.friendlyName}` : ''}
                </div>
              </div>
            </>
          ) : (
            <div className="preview-frame flex items-center justify-center">
              <EmptyState
                icon={<SparkIcon size={22} />}
                title={wallpapers.length === 0 ? 'Bring your desktop to life' : 'No wallpaper assigned yet'}
                action={
                  wallpapers.length === 0 ? (
                    <Button variant="primary" icon={<PlusIcon size={16} />} disabled={importing} onClick={() => void importFromDialog()}>
                      Import a wallpaper
                    </Button>
                  ) : (
                    <Button variant="primary" onClick={() => onNavigate('library')}>
                      Choose from your library
                    </Button>
                  )
                }
              >
                {wallpapers.length === 0 ? 'Import a video, image or .awall package to get started.' : 'Pick one in your library and assign it to a display.'}
              </EmptyState>
            </div>
          )}
        </section>

        <Card className="flex flex-col p-4">
          <SectionTitle aside={<EngineConnectionBadge connection={status.connection} />}>Engine</SectionTitle>
          <dl className="m-0 divide-y divide-line">
            <KeyValue label="Graphics">
              <span title={gpu?.selectedAdapter?.name}>{gpu ? (gpu.selectedAdapter?.name ?? 'None supported') : '—'}</span>
            </KeyValue>
            <KeyValue label="Primary display">{primaryVisibility ? <VisibilityBadge state={primaryVisibility.state} fraction={primaryVisibility.visibleFraction} /> : '—'}</KeyValue>
            <KeyValue label="Decision">{primaryRender ? <DecisionBadge decision={primaryRender.decision} /> : '—'}</KeyValue>
            <KeyValue label="Reason">{primaryRender ? REASON_LABELS[primaryRender.reason] : '—'}</KeyValue>
            <KeyValue label="Memory">{status.health ? formatBytes(status.health.workingSetBytes) : '—'}</KeyValue>
          </dl>
          {status.lastError && <p className="mt-3 text-[13px] text-bad">{status.lastError}</p>}
        </Card>
      </div>

      <section className="mt-8">
        <SectionTitle>Recently used</SectionTitle>
        {recent.length > 0 ? (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {recent.map((wallpaper) => (
              <WallpaperCard key={wallpaper.id} wallpaper={wallpaper} assigned={assignedIds.has(wallpaper.id)} onSelect={() => onNavigate('library')} />
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-ink-3">Wallpapers you assign to a display will appear here.</p>
        )}
      </section>

      <section className="mt-8 mb-2">
        <SectionTitle aside={<Badge tone="warn">Placeholder</Badge>}>Featured collections</SectionTitle>
        <div className="grid grid-cols-3 gap-4">
          {FEATURED_PLACEHOLDERS.map((collection) => (
            <button
              key={collection.title}
              type="button"
              onClick={() => onNavigate('marketplace')}
              style={{ backgroundImage: collection.gradient }}
              className="flex h-28 cursor-pointer flex-col justify-end rounded-card border border-line p-3.5 text-left transition-transform duration-200 ease-out hover:-translate-y-0.5"
            >
              <span className="font-display text-[15px] font-semibold text-white">{collection.title}</span>
              <span className="text-xs text-white/70">Sample artwork, not a real collection</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
