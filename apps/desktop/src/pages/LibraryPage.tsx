import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { Badge, Button, CloseIcon, Dialog, EmptyState, IconButton, KeyValue, LibraryIcon, PageHeader, PlusIcon, SearchField, Segmented, Select, TrashIcon, cx } from '@animated-walls/design-system';
import type { WallpaperQuery, WallpaperRecord } from '@animated-walls/shared-types';
import { WallpaperArt } from '../components/WallpaperArt';
import { WallpaperCard } from '../components/WallpaperCard';
import { useImport } from '../hooks/useImport';
import { api } from '../services/api';
import { KIND_LABELS, formatBytes, formatDate, formatResolution } from '../services/format';
import { assignmentsStore, engineStateStore, notify, refreshWallpapers, reportFailure, wallpapersStore } from '../stores/appStores';
import { useStore } from '../stores/createStore';

const TYPE_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'video', label: 'Video' },
  { value: 'image', label: 'Image' },
  { value: 'web', label: 'Web' },
] as const;

export function LibraryPage() {
  const allWallpapers = useStore(wallpapersStore);
  const assignments = useStore(assignmentsStore);
  const { importFromDialog, importFile, importing } = useImport();

  const [search, setSearch] = useState('');
  const [type, setType] = useState<NonNullable<WallpaperQuery['type']>>('all');
  const [sort, setSort] = useState<NonNullable<WallpaperQuery['sort']>>('recent');
  const [results, setResults] = useState<WallpaperRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  // The database does the filtering, so this stays correct as the library grows.
  useEffect(() => {
    let cancelled = false;
    api.wallpapers
      .list({ search, type, sort })
      .then((rows) => {
        if (!cancelled) setResults(rows);
      })
      .catch((error: unknown) => reportFailure('The library could not be read', error));
    return () => {
      cancelled = true;
    };
  }, [search, type, sort, allWallpapers]);

  const assignedIds = useMemo(() => new Set(assignments.map((item) => item.wallpaperId)), [assignments]);
  const selected = allWallpapers.find((item) => item.id === selectedId) ?? null;

  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    setDragging(false);
    // Sequential, so each file's outcome is reported in order.
    void (async () => {
      for (const file of Array.from(event.dataTransfer.files)) await importFile(file);
    })();
  };

  return (
    <div
      className="flex h-full"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="relative min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl animate-page px-8 py-7">
          <PageHeader
            title="Library"
            description={`${allWallpapers.length} ${allWallpapers.length === 1 ? 'wallpaper' : 'wallpapers'}`}
            actions={
              <Button variant="primary" icon={<PlusIcon size={16} />} disabled={importing} onClick={() => void importFromDialog()} data-testid="import-button">
                {importing ? 'Importing…' : 'Import'}
              </Button>
            }
          />

          {allWallpapers.length > 0 && (
            <div className="mb-5 flex flex-wrap items-center gap-3">
              <SearchField placeholder="Search by name or creator" value={search} onChange={(event) => setSearch(event.target.value)} className="w-72" aria-label="Search wallpapers" />
              <Segmented label="Filter by type" value={type} options={TYPE_OPTIONS} onChange={setType} />
              <Select aria-label="Sort by" value={sort} onChange={(event) => setSort(event.target.value as NonNullable<WallpaperQuery['sort']>)} className="ml-auto">
                <option value="recent">Recently imported</option>
                <option value="used">Recently used</option>
                <option value="name">Name</option>
              </Select>
            </div>
          )}

          {allWallpapers.length === 0 ? (
            <div className="rounded-hero border border-dashed border-line-strong">
              <EmptyState
                icon={<LibraryIcon size={22} />}
                title="Your library is empty"
                action={
                  <Button variant="primary" icon={<PlusIcon size={16} />} disabled={importing} onClick={() => void importFromDialog()}>
                    Import a wallpaper
                  </Button>
                }
              >
                Drop files here, or import a .awall package, MP4, WebM, PNG, JPG or WebP.
              </EmptyState>
            </div>
          ) : results.length === 0 ? (
            <EmptyState title="Nothing matches">Try a different search or filter.</EmptyState>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4" data-testid="wallpaper-grid">
              {results.map((wallpaper) => (
                <WallpaperCard key={wallpaper.id} wallpaper={wallpaper} selected={wallpaper.id === selectedId} assigned={assignedIds.has(wallpaper.id)} onSelect={(item) => setSelectedId(item.id)} />
              ))}
            </div>
          )}
        </div>

        {dragging && (
          <div className="pointer-events-none absolute inset-3 z-10 flex animate-fade items-center justify-center rounded-hero border-2 border-dashed border-accent bg-accent-soft backdrop-blur-sm">
            <span className="font-display text-lg font-semibold text-accent-strong">Drop to import</span>
          </div>
        )}
      </div>

      {selected && <DetailsPanel key={selected.id} wallpaper={selected} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function DetailsPanel({ wallpaper, onClose }: { wallpaper: WallpaperRecord; onClose: () => void }) {
  const state = useStore(engineStateStore);
  const assignments = useStore(assignmentsStore);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [busy, setBusy] = useState(false);

  const displays = state?.displays ?? [];
  const assignedTo = assignments.filter((item) => item.wallpaperId === wallpaper.id);

  const toggleAssignment = async (displayId: string, assigned: boolean): Promise<void> => {
    setBusy(true);
    try {
      if (assigned) await api.wallpapers.unassign(displayId);
      else await api.wallpapers.assign(displayId, wallpaper.id);
      await refreshWallpapers();
    } catch (error) {
      reportFailure('The assignment could not be saved', error);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.wallpapers.remove(wallpaper.id);
      await refreshWallpapers();
      notify({ tone: 'ok', title: `Removed "${wallpaper.name}"` });
      onClose();
    } catch (error) {
      reportFailure('The wallpaper could not be removed', error);
      setBusy(false);
      setConfirmingRemoval(false);
    }
  };

  return (
    <aside className="flex w-80 shrink-0 animate-fade flex-col overflow-y-auto border-l border-line bg-surface" aria-label="Wallpaper details" data-testid="details-panel">
      <div className="relative">
        <WallpaperArt wallpaper={wallpaper} playing className="preview-frame" />
        <IconButton label="Close details" onClick={onClose} className="absolute top-2 right-2 bg-black/50 text-white backdrop-blur-md hover:bg-black/70 hover:text-white">
          <CloseIcon size={16} />
        </IconButton>
      </div>

      <div className="flex-1 p-4">
        <h2 className="font-display text-lg leading-snug font-semibold text-ink select-text">{wallpaper.name}</h2>
        <p className="text-[13px] text-ink-2 select-text">{wallpaper.creatorName}</p>
        {wallpaper.description && <p className="mt-2 text-[13px] text-ink-2 select-text">{wallpaper.description}</p>}

        <h3 className="mt-5 mb-2 text-xs font-medium tracking-wide text-ink-3">Show on</h3>
        {displays.length === 0 ? (
          <p className="text-[13px] text-ink-3">Displays appear once the engine is running.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {displays.map((display) => {
              const assigned = assignedTo.some((item) => item.displayId === display.id);
              return (
                <button
                  key={display.id}
                  type="button"
                  disabled={busy}
                  aria-pressed={assigned}
                  onClick={() => void toggleAssignment(display.id, assigned)}
                  data-testid="assign-display"
                  className={cx(
                    'flex cursor-pointer items-center justify-between gap-2 rounded-control border px-3 py-2 text-left text-[13px] transition-colors disabled:cursor-wait',
                    assigned ? 'border-accent bg-accent-soft text-ink' : 'border-line-strong text-ink-2 hover:bg-raised hover:text-ink',
                  )}
                >
                  <span className="truncate">{display.friendlyName}</span>
                  <span className="shrink-0 text-xs">{assigned ? 'Assigned' : 'Assign'}</span>
                </button>
              );
            })}
          </div>
        )}

        <dl className="m-0 mt-5 divide-y divide-line">
          <KeyValue label="Type">{KIND_LABELS[wallpaper.type]}</KeyValue>
          <KeyValue label="Resolution">{formatResolution(wallpaper.width, wallpaper.height)}</KeyValue>
          <KeyValue label="Size">{formatBytes(wallpaper.sizeBytes)}</KeyValue>
          <KeyValue label="Audio">{wallpaper.hasAudio ? 'Yes' : 'None'}</KeyValue>
          <KeyValue label="Interactive">{wallpaper.interactive ? 'Yes' : 'No'}</KeyValue>
          <KeyValue label="Format">{wallpaper.source === 'package' ? `.awall v${wallpaper.formatVersion}` : 'Media file'}</KeyValue>
          <KeyValue label="Imported">{formatDate(wallpaper.importedAt)}</KeyValue>
        </dl>

        {wallpaper.type !== 'video' && (
          <p className="mt-4 rounded-control bg-warn-soft px-3 py-2.5 text-[12.5px] text-warn" data-testid="type-not-playable">
            {wallpaper.type === 'web' ? 'Web' : 'Image'} wallpapers can't play on your desktop yet. Video wallpapers can.
          </p>
        )}

        {wallpaper.type === 'web' && (
          <div className="mt-4 flex items-start gap-2">
            <Badge tone="neutral">Web</Badge>
            <p className="m-0 text-xs text-ink-3">Web wallpapers run third-party code. They will always run sandboxed, with no access to your files or this app.</p>
          </div>
        )}
      </div>

      <div className="border-t border-line p-3">
        <Button variant="ghost" icon={<TrashIcon size={16} />} className="w-full hover:text-bad" onClick={() => setConfirmingRemoval(true)} data-testid="remove-button">
          Remove from library
        </Button>
      </div>

      <Dialog
        open={confirmingRemoval}
        title={`Remove "${wallpaper.name}"?`}
        onClose={() => setConfirmingRemoval(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmingRemoval(false)}>
              Keep
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()} data-testid="confirm-remove">
              Remove
            </Button>
          </>
        }
      >
        The library copy is deleted. Your original file, if it still exists, is not affected.
      </Dialog>
    </aside>
  );
}
