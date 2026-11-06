using AnimatedWalls.Engine.Core;

namespace AnimatedWalls.Engine.Playback;

/// <summary>
/// The rule for whether a display may draw frames. This is pure so every row of the
/// product's behaviour table can be a unit test.
///
/// Three different things are often called "suspended", and this class owns only
/// the third:
///   1. Process shutdown: the engine exits.
///   2. Application suspension: the Electron UI is hidden, the engine keeps running.
///   3. Rendering suspension: the engine runs, and a display draws and decodes nothing.
/// </summary>
public static class RenderPolicy
{
    public readonly record struct Inputs(
        string? WallpaperId,
        string VisibilityState,
        SessionState Session,
        bool ExclusiveOnThisDisplay,
        bool GpuSupported,
        bool UserPaused,
        bool PauseOnBattery,
        bool TypeSupported = true,
        string? FailureReason = null);

    public static (string Decision, string Reason) Decide(in Inputs inputs)
    {
        if (inputs.WallpaperId is null) return (RenderDecisions.Idle, RenderReasons.NoWallpaperAssigned);

        // Blocked, not suspended: this will not resolve itself, and the user must be told.
        if (!inputs.GpuSupported) return (RenderDecisions.Blocked, RenderReasons.GpuUnsupported);

        if (inputs.Session.SystemSuspended) return (RenderDecisions.Suspended, RenderReasons.SystemSuspended);
        if (inputs.Session.Locked) return (RenderDecisions.Suspended, RenderReasons.SessionLocked);
        if (inputs.Session.SessionDisconnected) return (RenderDecisions.Suspended, RenderReasons.SessionDisconnected);
        if (inputs.Session.ScreenSaverRunning) return (RenderDecisions.Suspended, RenderReasons.ScreenSaver);
        if (inputs.Session.DisplayPower == DisplayPowerStates.Off) return (RenderDecisions.Suspended, RenderReasons.DisplayOff);
        if (inputs.UserPaused) return (RenderDecisions.Suspended, RenderReasons.UserPaused);
        if (inputs.PauseOnBattery && inputs.Session.OnBattery) return (RenderDecisions.Suspended, RenderReasons.OnBattery);
        if (inputs.ExclusiveOnThisDisplay) return (RenderDecisions.Suspended, RenderReasons.ExclusiveFullscreen);

        // Blocked rather than suspended, and after the checks above so the reason shown is the
        // one that matters first. Neither of these clears by itself.
        if (!inputs.TypeSupported) return (RenderDecisions.Blocked, RenderReasons.UnsupportedWallpaperType);
        if (inputs.FailureReason is { } failure) return (RenderDecisions.Blocked, failure);

        return inputs.VisibilityState switch
        {
            VisibilityStates.Covered => (RenderDecisions.Suspended, RenderReasons.DesktopCovered),
            VisibilityStates.Partial => (RenderDecisions.Render, RenderReasons.PartiallyVisible),
            _ => (RenderDecisions.Render, RenderReasons.DesktopVisible),
        };
    }
}
