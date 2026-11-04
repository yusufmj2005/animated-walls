using System.Runtime.InteropServices;
using AnimatedWalls.Engine.Core;

namespace AnimatedWalls.Engine.Displays;

/// <summary>Reads the current monitor layout from Win32.</summary>
public static unsafe class DisplayEnumerator
{
    private const uint QDC_ONLY_ACTIVE_PATHS = 2;
    private const uint DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME = 1;
    private const uint DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME = 2;
    private const int MDT_EFFECTIVE_DPI = 0;
    private const int DefaultDpi = 96;

    public static List<DisplayInfo> Enumerate()
    {
        var names = ReadTargetNames();
        var displays = new List<DisplayInfo>();
        var handle = GCHandle.Alloc(displays);
        var state = new EnumerationState(displays, names);
        var stateHandle = GCHandle.Alloc(state);
        try
        {
            if (!User32.EnumDisplayMonitors(0, 0, &MonitorCallback, GCHandle.ToIntPtr(stateHandle)))
            {
                throw new InvalidOperationException($"EnumDisplayMonitors failed with error {Marshal.GetLastPInvokeError()}.");
            }
        }
        finally
        {
            stateHandle.Free();
            handle.Free();
        }
        if (state.Failure is not null) throw new InvalidOperationException("Display enumeration failed.", state.Failure);

        // Primary first, then left to right, so the order is stable and readable.
        displays.Sort(static (a, b) =>
        {
            if (a.IsPrimary != b.IsPrimary) return a.IsPrimary ? -1 : 1;
            var byX = a.Bounds.X.CompareTo(b.Bounds.X);
            return byX != 0 ? byX : a.Bounds.Y.CompareTo(b.Bounds.Y);
        });
        return displays;
    }

    private sealed class EnumerationState(List<DisplayInfo> displays, Dictionary<string, TargetName> names)
    {
        public List<DisplayInfo> Displays { get; } = displays;
        public Dictionary<string, TargetName> Names { get; } = names;
        public Exception? Failure { get; set; }
    }

    private readonly record struct TargetName(string FriendlyName, string DevicePath);

    [UnmanagedCallersOnly]
    private static int MonitorCallback(nint monitor, nint hdc, NativeRect* clip, nint stateHandle)
    {
        var state = (EnumerationState)GCHandle.FromIntPtr(stateHandle).Target!;
        try
        {
            state.Displays.Add(Describe(monitor, state.Names));
            return 1;
        }
        catch (Exception exception)
        {
            state.Failure = exception;
            return 0;
        }
    }

    private static DisplayInfo Describe(nint monitor, Dictionary<string, TargetName> names)
    {
        var info = new MonitorInfoEx { Size = (uint)sizeof(MonitorInfoEx) };
        if (!User32.GetMonitorInfo(monitor, &info))
        {
            throw new InvalidOperationException("GetMonitorInfo failed.");
        }
        var deviceName = new string(info.Device);

        var mode = new DevMode { Size = (ushort)sizeof(DevMode) };
        var hasMode = User32.EnumDisplaySettings(deviceName, User32.ENUM_CURRENT_SETTINGS, &mode);

        var dpi = Shcore.GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, out var dpiX, out _) == 0 ? (int)dpiX : DefaultDpi;

        names.TryGetValue(deviceName, out var target);
        var friendlyName = string.IsNullOrEmpty(target.FriendlyName) ? deviceName : target.FriendlyName;
        // The device path survives reboots and port changes better than \\.\DISPLAY1,
        // which is what makes a saved per-monitor wallpaper assignment reliable.
        var id = string.IsNullOrEmpty(target.DevicePath) ? deviceName : target.DevicePath;

        return new DisplayInfo(
            id,
            deviceName,
            friendlyName,
            info.Monitor.ToRect(),
            info.Work.ToRect(),
            hasMode ? (int)mode.DisplayFrequency : 0,
            dpi,
            (int)Math.Round(dpi * 100.0 / DefaultDpi),
            hasMode ? (int)mode.BitsPerPel : 0,
            (info.Flags & User32.MONITORINFOF_PRIMARY) != 0);
    }

    private static Dictionary<string, TargetName> ReadTargetNames()
    {
        var names = new Dictionary<string, TargetName>(StringComparer.OrdinalIgnoreCase);

        var status = User32.GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, out var pathCount, out var modeCount);
        if (status != 0) return names;

        var paths = new DisplayConfigPathInfo[pathCount];
        var modes = new DisplayConfigModeInfo[modeCount];
        fixed (DisplayConfigPathInfo* pathsPointer = paths)
        fixed (DisplayConfigModeInfo* modesPointer = modes)
        {
            status = User32.QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, ref pathCount, pathsPointer, ref modeCount, modesPointer, 0);
        }
        if (status != 0) return names;

        for (var index = 0; index < pathCount; index++)
        {
            var path = paths[index];

            var source = new DisplayConfigSourceDeviceName();
            source.Header.Type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
            source.Header.Size = (uint)sizeof(DisplayConfigSourceDeviceName);
            source.Header.AdapterId = path.SourceAdapterId;
            source.Header.Id = path.SourceId;
            if (User32.DisplayConfigGetDeviceInfo(&source) != 0) continue;

            var target = new DisplayConfigTargetDeviceName();
            target.Header.Type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
            target.Header.Size = (uint)sizeof(DisplayConfigTargetDeviceName);
            target.Header.AdapterId = path.TargetAdapterId;
            target.Header.Id = path.TargetId;
            if (User32.DisplayConfigGetDeviceInfo(&target) != 0) continue;

            names[new string(source.ViewGdiDeviceName)] = new TargetName(
                new string(target.MonitorFriendlyDeviceName),
                new string(target.MonitorDevicePath));
        }
        return names;
    }
}
