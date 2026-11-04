import { Badge, StatusDot, type Tone } from '@animated-walls/design-system';
import type { EngineStatus, RenderDecision, VisibilityState } from '@animated-walls/shared-types';

const CONNECTION: Record<EngineStatus['connection'], { label: string; tone: Tone }> = {
  connected: { label: 'Running', tone: 'ok' },
  starting: { label: 'Starting', tone: 'warn' },
  restarting: { label: 'Restarting', tone: 'warn' },
  stopped: { label: 'Stopped', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'bad' },
};

export function EngineConnectionBadge({ connection }: { connection: EngineStatus['connection'] }) {
  const { label, tone } = CONNECTION[connection];
  return (
    <Badge tone={tone}>
      <StatusDot tone={tone} className="size-1.5" />
      {label}
    </Badge>
  );
}

const VISIBILITY: Record<VisibilityState, { label: string; tone: Tone }> = {
  visible: { label: 'Visible', tone: 'ok' },
  partial: { label: 'Partly visible', tone: 'accent' },
  covered: { label: 'Covered', tone: 'neutral' },
};

export function VisibilityBadge({ state, fraction }: { state: VisibilityState; fraction?: number }) {
  const { label, tone } = VISIBILITY[state];
  return (
    <Badge tone={tone}>
      {label}
      {fraction !== undefined && state === 'partial' ? ` ${Math.round(fraction * 100)}%` : ''}
    </Badge>
  );
}

const DECISION: Record<RenderDecision, { label: string; tone: Tone }> = {
  render: { label: 'Would render', tone: 'ok' },
  suspended: { label: 'Suspended', tone: 'neutral' },
  blocked: { label: 'Blocked', tone: 'bad' },
  idle: { label: 'Idle', tone: 'neutral' },
};

/** The word "would" stays until the renderer ships: these are decisions, not frames. */
export function DecisionBadge({ decision, rendererImplemented }: { decision: RenderDecision; rendererImplemented: boolean }) {
  const { label, tone } = DECISION[decision];
  return <Badge tone={tone}>{decision === 'render' && rendererImplemented ? 'Rendering' : label}</Badge>;
}
