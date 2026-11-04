using System.Runtime.InteropServices;
using AnimatedWalls.Engine.Core;

namespace AnimatedWalls.Engine.Visibility;

/// <summary>Walks top-level windows from the top of the z-order down to the desktop.</summary>
public static unsafe class WindowSnapshotProvider
{
    private const int NullRegion = 1;
    private const int ComplexRegion = 3;

    public sealed record WindowDump(string ClassName, Rect Bounds, bool Occludes, uint ExStyle, uint ProcessId);

    /// <summary>Returns opaque windows above the desktop, topmost first.</summary>
    public static List<Occluder> Capture()
    {
        var result = new List<Occluder>(32);
        var ownProcess = (uint)Environment.ProcessId;
        Walk(window =>
        {
            if (window.ProcessId != ownProcess && WindowClassifier.IsOccluder(window.Properties))
            {
                result.Add(new Occluder(window.Properties.Bounds, window.Properties.ClassName));
            }
        });
        return result;
    }

    /// <summary>Every visible window above the desktop with its classification, for diagnostics.</summary>
    public static List<WindowDump> Dump()
    {
        var result = new List<WindowDump>(32);
        Walk(window =>
        {
            if (window.Properties.IsVisible)
            {
                result.Add(new WindowDump(
                    window.Properties.ClassName,
                    window.Properties.Bounds,
                    WindowClassifier.IsOccluder(window.Properties),
                    window.Properties.ExStyle,
                    window.ProcessId));
            }
        });
        return result;
    }

    private readonly record struct WalkItem(WindowProperties Properties, uint ProcessId);

    private sealed class WalkState(Action<WalkItem> visit)
    {
        public Action<WalkItem> Visit { get; } = visit;
        public Exception? Failure { get; set; }
    }

    private static void Walk(Action<WalkItem> visit)
    {
        var state = new WalkState(visit);
        var handle = GCHandle.Alloc(state);
        try
        {
            User32.EnumWindows(&EnumCallback, GCHandle.ToIntPtr(handle));
        }
        finally
        {
            handle.Free();
        }
        if (state.Failure is not null) throw new InvalidOperationException("The window walk failed.", state.Failure);
    }

    [UnmanagedCallersOnly]
    private static int EnumCallback(nint hwnd, nint stateHandle)
    {
        var state = (WalkState)GCHandle.FromIntPtr(stateHandle).Target!;
        try
        {
            var properties = Read(hwnd);
            if (WindowClassifier.IsDesktopLayer(properties)) return 0;

            User32.GetWindowThreadProcessId(hwnd, out var processId);
            state.Visit(new WalkItem(properties, processId));
            return 1;
        }
        catch (Exception exception)
        {
            // Exceptions must not cross a native callback frame.
            state.Failure = exception;
            return 0;
        }
    }

    private static WindowProperties Read(nint hwnd)
    {
        var className = User32.ClassNameOf(hwnd);
        var visible = User32.IsWindowVisible(hwnd);
        var exStyle = (uint)(long)User32.GetWindowLongPtr(hwnd, User32.GWL_EXSTYLE);

        // Hidden windows are the great majority, so skip the costlier queries for them.
        if (!visible)
        {
            return new WindowProperties(className, default, false, false, false, exStyle, false, 0, 0, false, false);
        }

        var minimized = User32.IsIconic(hwnd);
        var cloaked = Dwmapi.DwmGetWindowAttributeInt(hwnd, Dwmapi.DWMWA_CLOAKED, out var cloakedValue, sizeof(int)) == 0 && cloakedValue != 0;

        var bounds = default(Rect);
        // Extended frame bounds exclude the invisible resize border. GetWindowRect
        // reports a rectangle about 8px too large on each side of a normal window.
        if (Dwmapi.DwmGetWindowAttribute(hwnd, Dwmapi.DWMWA_EXTENDED_FRAME_BOUNDS, out var frame, (uint)sizeof(NativeRect)) == 0)
        {
            bounds = frame.ToRect();
        }
        else if (User32.GetWindowRect(hwnd, out var rect))
        {
            bounds = rect.ToRect();
        }

        var hasLayered = false;
        byte alpha = 255;
        uint flags = 0;
        if ((exStyle & User32.WS_EX_LAYERED) != 0)
        {
            hasLayered = User32.GetLayeredWindowAttributes(hwnd, out _, out alpha, out flags);
        }

        var hostsIcons = className == "WorkerW" && User32.FindWindowEx(hwnd, 0, "SHELLDLL_DefView", null) != 0;

        return new WindowProperties(className, bounds, visible, minimized, cloaked, exStyle, hasLayered, alpha, flags, HasShapedRegion(hwnd), hostsIcons);
    }

    private static bool HasShapedRegion(nint hwnd)
    {
        var region = Gdi32.CreateRectRgn(0, 0, 0, 0);
        if (region == 0) return false;
        try
        {
            var type = User32.GetWindowRgn(hwnd, region);
            return type is NullRegion or ComplexRegion;
        }
        finally
        {
            Gdi32.DeleteObject(region);
        }
    }
}
