using System.Text.Json.Serialization;

namespace AnimatedWalls.Engine.Core;

/// <summary>A rectangle in physical desktop pixels.</summary>
public readonly record struct Rect(int X, int Y, int Width, int Height)
{
    [JsonIgnore] public int Right => X + Width;
    [JsonIgnore] public int Bottom => Y + Height;
    [JsonIgnore] public long Area => IsEmpty ? 0 : (long)Width * Height;
    [JsonIgnore] public bool IsEmpty => Width <= 0 || Height <= 0;

    public static Rect FromEdges(int left, int top, int right, int bottom) => new(left, top, right - left, bottom - top);

    public Rect Intersect(Rect other)
    {
        var left = Math.Max(X, other.X);
        var top = Math.Max(Y, other.Y);
        var right = Math.Min(Right, other.Right);
        var bottom = Math.Min(Bottom, other.Bottom);
        return right > left && bottom > top ? FromEdges(left, top, right, bottom) : default;
    }
}

public sealed record DisplayInfo(
    string Id,
    string DeviceName,
    string FriendlyName,
    Rect Bounds,
    Rect WorkArea,
    int RefreshRateHz,
    int Dpi,
    int ScalePercent,
    int BitsPerPixel,
    bool IsPrimary);

public static class VisibilityStates
{
    public const string Visible = "visible";
    public const string Partial = "partial";
    public const string Covered = "covered";
}

public sealed record DisplayVisibility(
    string DisplayId,
    string State,
    double VisibleFraction,
    IReadOnlyList<Rect> VisibleRects,
    string? TopOccluderClass);

public sealed record SessionState(
    bool Locked,
    string DisplayPower,
    bool SystemSuspended,
    bool OnBattery,
    bool ExclusiveFullscreen)
{
    /// <summary>GDI device name of the display an exclusive fullscreen app owns.</summary>
    [JsonIgnore] public string? ExclusiveDeviceName { get; init; }

    /// <summary>Nobody is connected to this session, as after a Remote Desktop disconnect.</summary>
    public bool SessionDisconnected { get; init; }

    public bool ScreenSaverRunning { get; init; }
}

public static class DisplayPowerStates
{
    public const string On = "on";
    public const string Off = "off";
    public const string Dimmed = "dimmed";
    public const string Unknown = "unknown";
}

public static class RenderDecisions
{
    public const string Render = "render";
    public const string Suspended = "suspended";
    public const string Blocked = "blocked";
    public const string Idle = "idle";
}

public static class RenderReasons
{
    public const string DesktopVisible = "desktop-visible";
    public const string PartiallyVisible = "partially-visible";
    public const string NoWallpaperAssigned = "no-wallpaper-assigned";
    public const string GpuUnsupported = "gpu-unsupported";
    public const string DesktopCovered = "desktop-covered";
    public const string ExclusiveFullscreen = "exclusive-fullscreen";
    public const string SessionLocked = "session-locked";
    public const string SessionDisconnected = "session-disconnected";
    public const string ScreenSaver = "screen-saver";
    public const string DisplayOff = "display-off";
    public const string SystemSuspended = "system-suspended";
    public const string OnBattery = "on-battery";
    public const string UserPaused = "user-paused";
}

public sealed record DisplayRenderState(
    string DisplayId,
    string Decision,
    string Reason,
    string? WallpaperId,
    string SinceUtc);

public sealed record EngineState(
    IReadOnlyList<DisplayInfo> Displays,
    IReadOnlyList<DisplayVisibility> Visibility,
    SessionState Session,
    IReadOnlyList<DisplayRenderState> Render,
    bool Paused);

public sealed record DisplayAssignment(string DisplayId, string WallpaperId);

public sealed record PlaybackConfig(int FrameRateLimit, string Quality, bool PauseOnBattery)
{
    public static PlaybackConfig Default { get; } = new(60, "high", true);
}

public sealed record GpuAdapter(
    string Name,
    int VendorId,
    int DeviceId,
    string Luid,
    long DedicatedVideoMemoryBytes,
    bool IsSoftware,
    string? FeatureLevel,
    IReadOnlyList<string> HardwareDecodeCodecs,
    IReadOnlyList<string> ConnectedOutputs,
    string? RejectedReason);

public sealed record GpuCapabilities(
    string Status,
    GpuAdapter? SelectedAdapter,
    IReadOnlyList<GpuAdapter> Adapters,
    IReadOnlyList<string> UnsupportedReasons,
    string? WebView2Version,
    string DetectedAtUtc)
{
    [JsonIgnore] public bool IsSupported => Status == "supported";
}

public sealed record GpuProcessUsage(bool Available, double Engine3DPercent, double VideoDecodePercent, string? Error);

public sealed record DesktopHostProbe(
    string Layout,
    bool ProgmanFound,
    string? DefViewParentClass,
    bool ProgmanHasNoRedirectionBitmap,
    bool DefViewIsLayered,
    bool HostWindowPresent,
    string Notes);

public sealed record EngineCounterValues(
    long WinEventsReceived,
    long VisibilityEvaluations,
    long RenderTransitions,
    long FramesPresented,
    long FramesDecoded);

public sealed record EngineHealth(
    int Pid,
    string EngineVersion,
    int ProtocolVersion,
    long UptimeMs,
    long WorkingSetBytes,
    long ManagedHeapBytes,
    int ThreadCount,
    bool RendererImplemented,
    EngineCounterValues Counters);

public sealed record EngineDiagnostics(
    EngineHealth Health,
    EngineState State,
    GpuCapabilities Gpu,
    GpuProcessUsage GpuUsage,
    DesktopHostProbe DesktopHost,
    string? LogFile);
