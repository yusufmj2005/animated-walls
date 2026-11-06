import { useEffect, useState, type ReactNode } from 'react';
import { Badge, Button, Card, FolderIcon, KeyValue, PageHeader, PulseIcon, RefreshIcon, Segmented, Select, Switch } from '@animated-walls/design-system';
import { FRAME_RATE_OPTIONS, type AppInfo, type EngineDiagnostics, type GpuAdapter, type LogLevel } from '@animated-walls/shared-types';
import { EngineConnectionBadge } from '../components/EngineSummary';
import { api } from '../services/api';
import { formatBytes } from '../services/format';
import { changeSetting, engineStatusStore, gpuStore, reportFailure, settingsStore } from '../stores/appStores';
import { useStore } from '../stores/createStore';

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="grid grid-cols-[200px_minmax(0,1fr)] gap-6 border-t border-line pt-6">
      <div>
        <h2 className="font-display text-[15px] font-semibold text-ink">{title}</h2>
        {description && <p className="mt-1 text-[12.5px] text-ink-3">{description}</p>}
      </div>
      <Card className="divide-y divide-line">{children}</Card>
    </section>
  );
}

function Row({ title, hint, control }: { title: string; hint?: string; control: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <div className="min-w-0">
        <div className="text-[13.5px] text-ink">{title}</div>
        {hint && <div className="mt-0.5 text-[12.5px] text-ink-3">{hint}</div>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function adapterSummary(adapter: GpuAdapter): string {
  if (adapter.rejectedReason) return adapter.rejectedReason;
  return `Direct3D ${adapter.featureLevel?.replace('_', '.')} · ${formatBytes(adapter.dedicatedVideoMemoryBytes)}`;
}

export function SettingsPage() {
  const settings = useStore(settingsStore);
  const gpu = useStore(gpuStore);
  const status = useStore(engineStatusStore);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [diagnostics, setDiagnostics] = useState<EngineDiagnostics | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);

  useEffect(() => {
    api.app.getInfo().then(setInfo).catch((error: unknown) => reportFailure('App information could not be read', error));
  }, []);

  const runDiagnostics = async (): Promise<void> => {
    setDiagnosing(true);
    try {
      setDiagnostics(await api.engine.getDiagnostics());
    } catch (error) {
      reportFailure('Diagnostics could not be read', error);
    } finally {
      setDiagnosing(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-5xl animate-page flex-col gap-6 px-8 py-7 pb-12">
      <PageHeader title="Settings" />

      <Section title="General" description="How Animated Walls starts and closes.">
        <Row
          title="Start with Windows"
          hint={info && !info.isPackaged ? 'Takes effect in installed builds only.' : undefined}
          control={<Switch label="Start with Windows" checked={settings.launchAtStartup} onChange={(value) => void changeSetting('launchAtStartup', value)} />}
        />
        <Row title="Start hidden in the tray" control={<Switch label="Start hidden in the tray" checked={settings.startMinimized} onChange={(value) => void changeSetting('startMinimized', value)} />} />
        <Row
          title="Keep running in the tray when closed"
          hint="Closing the window keeps wallpapers running. Use Quit in the tray menu to exit."
          control={<Switch label="Keep running in the tray when closed" checked={settings.closeToTray} onChange={(value) => void changeSetting('closeToTray', value)} />}
        />
      </Section>

      <Section title="Performance" description="Saved now and sent to the engine. Frame rate and quality apply once the renderer ships.">
        <Row
          title="Frame rate limit"
          control={
            <Select aria-label="Frame rate limit" value={settings.frameRateLimit} onChange={(event) => void changeSetting('frameRateLimit', Number(event.target.value) as (typeof FRAME_RATE_OPTIONS)[number])} data-testid="frame-rate">
              {FRAME_RATE_OPTIONS.map((rate) => (
                <option key={rate} value={rate}>
                  {rate === 0 ? 'Match display' : `${rate} FPS`}
                </option>
              ))}
            </Select>
          }
        />
        <Row
          title="Rendering quality"
          control={
            <Segmented
              label="Rendering quality"
              value={settings.renderQuality}
              onChange={(value) => void changeSetting('renderQuality', value)}
              options={[
                { value: 'balanced', label: 'Balanced' },
                { value: 'high', label: 'High' },
                { value: 'maximum', label: 'Maximum' },
              ]}
            />
          }
        />
        <Row title="Pause on battery" hint="Suspends wallpapers while running on battery." control={<Switch label="Pause on battery" checked={settings.pauseOnBattery} onChange={(value) => void changeSetting('pauseOnBattery', value)} />} />
        <Row title="Pause all wallpapers" control={<Switch label="Pause all wallpapers" checked={settings.pausePlayback} onChange={(value) => void changeSetting('pausePlayback', value)} />} />
      </Section>

      <Section title="Rendering" description="Wallpapers only ever render on hardware. There is no software fallback.">
        <div className="px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="text-[13.5px] text-ink" data-testid="gpu-name">
              {gpu?.selectedAdapter?.name ?? 'No hardware GPU available'}
            </div>
            {gpu && <Badge tone={gpu.status === 'supported' ? 'ok' : 'bad'}>{gpu.status === 'supported' ? 'GPU acceleration available' : 'Unsupported'}</Badge>}
          </div>
          {gpu?.selectedAdapter && (
            <dl className="m-0 mt-2 divide-y divide-line">
              <KeyValue label="Direct3D feature level">{gpu.selectedAdapter.featureLevel?.replace('_', '.')}</KeyValue>
              <KeyValue label="Video memory">{formatBytes(gpu.selectedAdapter.dedicatedVideoMemoryBytes)}</KeyValue>
              <KeyValue label="Hardware video decode">{gpu.selectedAdapter.hardwareDecodeCodecs.map((codec) => codec.toUpperCase()).join(', ') || 'None reported'}</KeyValue>
              <KeyValue label="WebView2 runtime">{gpu.webView2Version ?? 'Not installed'}</KeyValue>
            </dl>
          )}
          {gpu && gpu.unsupportedReasons.length > 0 && <p className="mt-2 text-[13px] text-bad">{gpu.unsupportedReasons.join(' ')}</p>}
          {gpu && gpu.adapters.length > 1 && (
            <details className="mt-2 text-[12.5px] text-ink-3">
              <summary className="cursor-pointer py-1 hover:text-ink-2">All adapters ({gpu.adapters.length})</summary>
              <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
                {gpu.adapters.map((adapter) => (
                  <li key={adapter.luid} className="flex justify-between gap-4">
                    <span>{adapter.name}</span>
                    <span className="text-right">{adapterSummary(adapter)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </Section>

      <Section title="Diagnostics" description="For understanding what the engine is doing, and for support.">
        <Row
          title="Engine"
          hint={status.health ? `Process ${status.health.pid} · ${formatBytes(status.health.workingSetBytes)}` : (status.lastError ?? undefined)}
          control={
            <div className="flex items-center gap-2">
              <EngineConnectionBadge connection={status.connection} />
              <Button icon={<RefreshIcon size={15} />} onClick={() => api.engine.restart().catch((error: unknown) => reportFailure('The engine could not be restarted', error))}>
                Restart
              </Button>
            </div>
          }
        />
        <Row
          title="Log level"
          control={
            <Select aria-label="Log level" value={settings.logLevel} onChange={(event) => void changeSetting('logLevel', event.target.value as LogLevel)}>
              <option value="debug">Debug</option>
              <option value="info">Info</option>
              <option value="warn">Warnings</option>
              <option value="error">Errors only</option>
            </Select>
          }
        />
        <Row
          title="Log files"
          hint="Structured logs from the app and the engine, rotated automatically."
          control={
            <Button icon={<FolderIcon size={15} />} onClick={() => api.app.openLogsFolder().catch((error: unknown) => reportFailure('The logs folder could not be opened', error))}>
              Open folder
            </Button>
          }
        />
        <div className="px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[13.5px] text-ink">Live measurements</div>
              <div className="mt-0.5 text-[12.5px] text-ink-3">GPU figures cover the engine process only, not the Windows compositor or other apps.</div>
            </div>
            <Button icon={<PulseIcon size={15} />} disabled={diagnosing || status.connection !== 'connected'} onClick={() => void runDiagnostics()} data-testid="run-diagnostics">
              {diagnosing ? 'Measuring…' : 'Measure'}
            </Button>
          </div>
          {diagnostics && (
            <dl className="m-0 mt-2 divide-y divide-line" data-testid="diagnostics-result">
              <KeyValue label="Engine GPU 3D">{diagnostics.gpuUsage.available ? `${diagnostics.gpuUsage.engine3DPercent}%` : (diagnostics.gpuUsage.error ?? 'Unavailable')}</KeyValue>
              <KeyValue label="Engine GPU decode">{diagnostics.gpuUsage.available ? `${diagnostics.gpuUsage.videoDecodePercent}%` : 'Unavailable'}</KeyValue>
              <KeyValue label="Frames presented">{diagnostics.health.counters.framesPresented}</KeyValue>
              <KeyValue label="Frames decoded">{diagnostics.health.counters.framesDecoded}</KeyValue>
              <KeyValue label="Visibility evaluations">{diagnostics.health.counters.visibilityEvaluations}</KeyValue>
              <KeyValue label="Render state changes">{diagnostics.health.counters.renderTransitions}</KeyValue>
              <KeyValue label="Desktop layout">{diagnostics.desktopHost.layout}</KeyValue>
              <KeyValue label="Wallpaper renderer">{diagnostics.health.rendererImplemented ? 'Active' : 'Not yet implemented'}</KeyValue>
            </dl>
          )}
        </div>
      </Section>

      <Section title="About">
        <div className="px-4 py-2">
          <dl className="m-0 divide-y divide-line">
            <KeyValue label="Version">{info?.version ?? '—'}</KeyValue>
            <KeyValue label="Engine">{status.health?.engineVersion ?? '—'}</KeyValue>
            <KeyValue label="Electron">{info?.electronVersion ?? '—'}</KeyValue>
            <KeyValue label="Chromium">{info?.chromeVersion ?? '—'}</KeyValue>
            <KeyValue label="Windows">{info?.platform ?? '—'}</KeyValue>
            <KeyValue label="Build">{info ? (info.isPackaged ? 'Installed' : 'Development') : '—'}</KeyValue>
          </dl>
        </div>
      </Section>
    </div>
  );
}
