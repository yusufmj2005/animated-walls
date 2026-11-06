/**
 * Wire contract between Electron and the native engine. The C# side lives in
 * engine/AnimatedWalls.Engine/IPC/Protocol.cs and must change with this file.
 * Bump ENGINE_PROTOCOL_VERSION on any incompatible change.
 */
export const ENGINE_PROTOCOL_VERSION = 1;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EngineHealth {
  pid: number;
  engineVersion: string;
  protocolVersion: number;
  uptimeMs: number;
  workingSetBytes: number;
  managedHeapBytes: number;
  threadCount: number;
  rendererImplemented: boolean;
  counters: EngineCounters;
}

export interface EngineCounters {
  winEventsReceived: number;
  visibilityEvaluations: number;
  renderTransitions: number;
  framesPresented: number;
  framesDecoded: number;
}

export interface GpuAdapter {
  name: string;
  vendorId: number;
  deviceId: number;
  luid: string;
  dedicatedVideoMemoryBytes: number;
  isSoftware: boolean;
  /** Highest Direct3D feature level from a hardware device, e.g. "12_1". */
  featureLevel: string | null;
  hardwareDecodeCodecs: VideoCodec[];
  connectedOutputs: string[];
  /** Why this adapter cannot render wallpapers, or null when it can. */
  rejectedReason: string | null;
}

export type VideoCodec = 'h264' | 'hevc' | 'vp8' | 'vp9' | 'av1';

export interface GpuCapabilities {
  status: 'supported' | 'unsupported';
  selectedAdapter: GpuAdapter | null;
  adapters: GpuAdapter[];
  /** Plain-language reasons playback is blocked. Empty when supported. */
  unsupportedReasons: string[];
  webView2Version: string | null;
  detectedAtUtc: string;
}

export interface DisplayInfo {
  /** Stable across reboots where Windows provides a device path. */
  id: string;
  deviceName: string;
  friendlyName: string;
  bounds: Rect;
  workArea: Rect;
  refreshRateHz: number;
  dpi: number;
  scalePercent: number;
  bitsPerPixel: number;
  isPrimary: boolean;
}

export type VisibilityState = 'visible' | 'partial' | 'covered';

export interface DisplayVisibility {
  displayId: string;
  state: VisibilityState;
  /** Fraction of the display showing the desktop, from 0 to 1. */
  visibleFraction: number;
  visibleRects: Rect[];
  /** Window class of the topmost window that intersects this display. */
  topOccluderClass: string | null;
}

export type DisplayPower = 'on' | 'off' | 'dimmed' | 'unknown';

export interface SessionState {
  locked: boolean;
  displayPower: DisplayPower;
  systemSuspended: boolean;
  onBattery: boolean;
  exclusiveFullscreen: boolean;
  sessionDisconnected: boolean;
  screenSaverRunning: boolean;
}

export type RenderDecision = 'render' | 'suspended' | 'blocked' | 'idle';

export type RenderReason =
  | 'desktop-visible'
  | 'partially-visible'
  | 'no-wallpaper-assigned'
  | 'gpu-unsupported'
  | 'desktop-covered'
  | 'exclusive-fullscreen'
  | 'session-locked'
  | 'session-disconnected'
  | 'screen-saver'
  | 'display-off'
  | 'system-suspended'
  | 'on-battery'
  | 'user-paused'
  | 'unsupported-wallpaper-type'
  | 'playback-failed'
  | 'no-hardware-decode';

export interface DisplayRenderState {
  displayId: string;
  decision: RenderDecision;
  reason: RenderReason;
  wallpaperId: string | null;
  sinceUtc: string;
}

export interface EngineState {
  displays: DisplayInfo[];
  visibility: DisplayVisibility[];
  session: SessionState;
  render: DisplayRenderState[];
  paused: boolean;
}

export interface GpuProcessUsage {
  available: boolean;
  /** 3D and video-decode engine use by this process only, in percent. */
  engine3DPercent: number;
  videoDecodePercent: number;
  error: string | null;
}

export interface DesktopHostProbe {
  layout: 'progman-child' | 'workerw-sibling' | 'unavailable';
  progmanFound: boolean;
  defViewParentClass: string | null;
  progmanHasNoRedirectionBitmap: boolean;
  defViewIsLayered: boolean;
  hostWindowPresent: boolean;
  notes: string;
}

export interface EngineDiagnostics {
  health: EngineHealth;
  state: EngineState;
  gpu: GpuCapabilities;
  gpuUsage: GpuProcessUsage;
  desktopHost: DesktopHostProbe;
  logFile: string | null;
}

export interface PlaybackConfig {
  /** Target frames per second, or 0 to match each display's refresh rate. */
  frameRateLimit: number;
  quality: 'balanced' | 'high' | 'maximum';
  pauseOnBattery: boolean;
}

export interface DisplayAssignment {
  displayId: string;
  wallpaperId: string;
  /** The file to play. Null for a type with no renderer yet. */
  mediaPath: string | null;
  mediaType: 'video' | 'image' | 'web';
}

export interface EngineMethods {
  'engine.health': { params: void; result: EngineHealth };
  'engine.capabilities': { params: void; result: GpuCapabilities };
  'engine.state': { params: void; result: EngineState };
  'engine.diagnostics': { params: void; result: EngineDiagnostics };
  'engine.shutdown': { params: void; result: { accepted: boolean } };
  'playback.setAssignments': { params: { assignments: DisplayAssignment[] }; result: EngineState };
  'playback.setPaused': { params: { paused: boolean }; result: EngineState };
  'playback.configure': { params: PlaybackConfig; result: EngineState };
  'diagnostics.setLogLevel': { params: { level: string }; result: { level: string } };
}

export interface EngineEvents {
  'state.changed': EngineState;
  'gpu.changed': GpuCapabilities;
}

/** Live status the supervisor reports for the engine process. */
export type EngineConnection = 'stopped' | 'starting' | 'connected' | 'restarting' | 'failed';

export interface EngineStatus {
  connection: EngineConnection;
  health: EngineHealth | null;
  lastError: string | null;
  restarts: number;
}
