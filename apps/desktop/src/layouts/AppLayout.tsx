import type { ComponentType, ReactNode } from 'react';
import { DisplayIcon, HomeIcon, LibraryIcon, SettingsIcon, StatusDot, StoreIcon, cx, type Tone } from '@animated-walls/design-system';
import type { EngineStatus } from '@animated-walls/shared-types';
import { engineStatusStore } from '../stores/appStores';
import { useStore } from '../stores/createStore';

export type PageId = 'home' | 'library' | 'marketplace' | 'displays' | 'settings';

const NAVIGATION: { id: PageId; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { id: 'home', label: 'Home', icon: HomeIcon },
  { id: 'library', label: 'Library', icon: LibraryIcon },
  { id: 'marketplace', label: 'Marketplace', icon: StoreIcon },
  { id: 'displays', label: 'Displays', icon: DisplayIcon },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];

const ENGINE_TONE: Record<EngineStatus['connection'], Tone> = {
  connected: 'ok',
  starting: 'warn',
  restarting: 'warn',
  stopped: 'neutral',
  failed: 'bad',
};

const ENGINE_LABEL: Record<EngineStatus['connection'], string> = {
  connected: 'Engine running',
  starting: 'Engine starting',
  restarting: 'Engine restarting',
  stopped: 'Engine stopped',
  failed: 'Engine failed',
};

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#262a50" />
      <path d="M4.5 8.5c2.5-2.2 5-2.2 7.5 0s5 2.2 7.5 0M4.5 12.5c2.5-2.2 5-2.2 7.5 0s5 2.2 7.5 0M4.5 16.5c2.5-2.2 5-2.2 7.5 0s5 2.2 7.5 0" stroke="#c9d3ff" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function AppLayout({ page, onNavigate, children }: { page: PageId; onNavigate: (page: PageId) => void; children: ReactNode }) {
  const status = useStore(engineStatusStore);

  return (
    <div className="grid h-full grid-cols-[216px_minmax(0,1fr)] grid-rows-[40px_minmax(0,1fr)]">
      {/* The whole top row is a drag handle; native window controls overlay its right end. */}
      <div className="drag-region col-span-2 flex items-center gap-2.5 px-4">
        <Logo />
        <span className="font-display text-[13px] font-semibold tracking-wide text-ink">Animated Walls</span>
      </div>

      <aside className="flex min-h-0 flex-col px-2.5 pt-3 pb-3">
        <nav aria-label="Main" className="flex flex-col gap-0.5">
          {NAVIGATION.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={page === id ? 'page' : undefined}
              onClick={() => onNavigate(id)}
              className={cx(
                'flex h-9.5 cursor-pointer items-center gap-3 rounded-control px-3 text-[13.5px] transition-colors duration-150',
                page === id ? 'bg-raised font-medium text-ink' : 'text-ink-2 hover:bg-surface hover:text-ink',
              )}
            >
              <span className={page === id ? 'text-accent' : ''}>
                <Icon size={18} />
              </span>
              {label}
            </button>
          ))}
        </nav>

        <button
          type="button"
          onClick={() => onNavigate('settings')}
          className="mt-auto flex cursor-pointer items-center gap-2.5 rounded-control px-3 py-2 text-xs text-ink-2 transition-colors hover:bg-surface hover:text-ink"
          data-testid="engine-status"
        >
          <StatusDot tone={ENGINE_TONE[status.connection]} />
          {ENGINE_LABEL[status.connection]}
        </button>
      </aside>

      <main className="min-h-0 overflow-y-auto rounded-tl-hero border-t border-l border-line bg-[#0d0f13]">{children}</main>
    </div>
  );
}
