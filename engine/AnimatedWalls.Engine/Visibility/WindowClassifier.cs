using AnimatedWalls.Engine.Core;

namespace AnimatedWalls.Engine.Visibility;

/// <summary>What the z-order walk learned about one top-level window.</summary>
public readonly record struct WindowProperties(
    string ClassName,
    Rect Bounds,
    bool IsVisible,
    bool IsMinimized,
    bool IsCloaked,
    uint ExStyle,
    bool HasLayeredAttributes,
    byte LayeredAlpha,
    uint LayeredFlags,
    bool HasComplexRegion,
    bool HostsDesktopIcons);

/// <summary>
/// Decides whether a window hides the wallpaper behind it. The rules are biased on
/// purpose: when unsure, a window does not count as an occluder. Wrongly saying
/// "visible" costs a little GPU time. Wrongly saying "covered" freezes a wallpaper
/// the user can see, which is the worse failure.
/// </summary>
public static class WindowClassifier
{
    // Shell surfaces that draw transparent, irregular content across large rectangles.
    private static readonly HashSet<string> NonOccludingClasses = new(StringComparer.Ordinal)
    {
        "Windows.UI.Core.CoreWindow",            // Start, Search and other shell flyouts
        "XamlExplorerHostIslandWindow",          // Alt+Tab and Task View overlays
        "Shell_InputSwitchTopLevelWindow",
        "TopLevelWindowForOverflowXamlIsland",
        "NotifyIconOverflowWindow",
        "tooltips_class32",
        "SysShadow",
        "#32768",                                // context menus
    };

    /// <summary>
    /// True when the walk has reached the desktop itself. Only the Progman window and
    /// the visible WorkerW holding the icons qualify. Windows keeps many hidden
    /// WorkerW windows higher in the z-order (16 on the build tested), so stopping at
    /// the first WorkerW would ignore real windows beneath it.
    /// </summary>
    public static bool IsDesktopLayer(in WindowProperties window)
    {
        if (window.ClassName == "Progman") return true;
        return window.ClassName == "WorkerW" && window.IsVisible && window.HostsDesktopIcons;
    }

    public static bool IsOccluder(in WindowProperties window)
    {
        if (!window.IsVisible || window.IsMinimized || window.IsCloaked) return false;
        if (window.Bounds.IsEmpty) return false;

        // Click-through windows are almost always overlays (game bars, recorders, HUDs).
        if ((window.ExStyle & User32.WS_EX_TRANSPARENT) != 0) return false;

        if (NonOccludingClasses.Contains(window.ClassName)) return false;

        if ((window.ExStyle & User32.WS_EX_LAYERED) != 0)
        {
            // GetLayeredWindowAttributes fails for per-pixel-alpha windows, whose
            // transparency cannot be read, so those stay non-occluding.
            if (!window.HasLayeredAttributes) return false;
            var usesColorKey = (window.LayeredFlags & User32.LWA_COLORKEY) != 0;
            var usesAlpha = (window.LayeredFlags & User32.LWA_ALPHA) != 0;
            if (usesColorKey || (usesAlpha && window.LayeredAlpha < 255)) return false;
        }

        // A custom shape covers less than its rectangle.
        if (window.HasComplexRegion) return false;

        // WS_EX_NOREDIRECTIONBITMAP says nothing about opacity. Chromium browsers set
        // it and are opaque, so it must not exclude a window.
        return true;
    }
}
