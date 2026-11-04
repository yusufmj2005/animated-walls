using AnimatedWalls.Engine.Core;
using AnimatedWalls.Engine.Diagnostics;
using AnimatedWalls.Engine.Displays;
using AnimatedWalls.Engine.Playback;

namespace AnimatedWalls.Engine.Visibility;

/// <summary>
/// Connects desktop signals to the playback coordinator: when something on the desktop
/// changes, it captures a window snapshot and recomputes per-display visibility.
/// </summary>
public sealed class VisibilityMonitor(
    DesktopSignalPump pump,
    PlaybackCoordinator coordinator,
    EngineCounters counters,
    StructuredLogger logger)
{
    private IReadOnlyList<DisplayInfo> _displays = [];
    private bool _locked;
    private string _displayPower = DisplayPowerStates.Unknown;
    private bool _systemSuspended;
    private bool _onBattery;

    public void Start()
    {
        pump.VisibilityDirty += Evaluate;
        pump.DisplaysDirty += RefreshDisplays;
        pump.SessionLockChanged += locked => { _locked = locked; PublishSession(); };
        pump.DisplayPowerChanged += power => { _displayPower = power; PublishSession(); };
        pump.SystemSuspendChanged += suspended => { _systemSuspended = suspended; PublishSession(); };
        pump.BatteryChanged += onBattery => { _onBattery = onBattery; PublishSession(); };

        if (Kernel32.GetSystemPowerStatus(out var power))
        {
            _onBattery = power.ACLineStatus == 0;
        }

        RefreshDisplays();
        PublishSession();
        Evaluate();
    }

    private void RefreshDisplays()
    {
        try
        {
            _displays = DisplayEnumerator.Enumerate();
            coordinator.UpdateDisplays(_displays);
        }
        catch (InvalidOperationException exception)
        {
            logger.Error("engine.displays", "displays.enumeration-failed", exception);
        }
    }

    private void Evaluate()
    {
        counters.VisibilityEvaluated();
        try
        {
            var occluders = WindowSnapshotProvider.Capture();
            coordinator.UpdateVisibility(_displays.Select(display => VisibilityCalculator.Evaluate(display, occluders)).ToArray());
            PublishSession();
        }
        catch (InvalidOperationException exception)
        {
            // A window can vanish mid-walk. The next event triggers a fresh evaluation.
            logger.Error("engine.visibility", "visibility.evaluation-failed", exception);
        }
    }

    private void PublishSession()
    {
        coordinator.UpdateSession(new SessionState(_locked, _displayPower, _systemSuspended, _onBattery, false)
            .WithExclusive(ReadExclusiveDevice()));
    }

    /// <summary>
    /// Device name of the monitor owned by an exclusive-fullscreen D3D app, if any.
    /// Borderless "fullscreen" games are ordinary windows and the z-order walk sees them;
    /// this catches true exclusive mode, where the walk alone is less trustworthy.
    /// </summary>
    private static unsafe string? ReadExclusiveDevice()
    {
        if (Shell32.SHQueryUserNotificationState(out var state) != 0 || state != Shell32.QUNS_RUNNING_D3D_FULL_SCREEN) return null;

        var monitor = User32.MonitorFromWindow(User32.GetForegroundWindow(), User32.MONITOR_DEFAULTTONULL);
        if (monitor == 0) return string.Empty;

        var info = new MonitorInfoEx { Size = (uint)sizeof(MonitorInfoEx) };
        return User32.GetMonitorInfo(monitor, &info) ? new string(info.Device) : string.Empty;
    }
}

internal static class SessionStateExtensions
{
    public static SessionState WithExclusive(this SessionState state, string? deviceName) =>
        state with { ExclusiveFullscreen = deviceName is not null, ExclusiveDeviceName = deviceName };
}
