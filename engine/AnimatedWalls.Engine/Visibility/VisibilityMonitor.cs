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
    // Signals arrive on the pump thread, while Start runs on the caller's.
    private readonly object _gate = new();
    private IReadOnlyList<DisplayInfo> _displays = [];
    private bool _locked;
    private bool _disconnected;
    private string _displayPower = DisplayPowerStates.Unknown;
    private bool _systemSuspended;
    private bool _onBattery;

    /// <summary>
    /// Connects to the pump. This must happen before the pump starts: Windows sends the
    /// current display power as soon as the notification is registered and never repeats
    /// it, so a later subscriber would stay at "unknown" until the display next changes.
    /// </summary>
    public void Subscribe()
    {
        pump.VisibilityDirty += Evaluate;
        pump.DisplaysDirty += RefreshDisplays;
        pump.SessionLockChanged += locked => UpdateSession(() => _locked = locked);
        // The event says what happened to a connection, not whether anyone is left, because
        // moving from console to Remote Desktop sends a disconnect and then a connect.
        pump.SessionConnectionChanged += () => UpdateSession(() => _disconnected = SessionInfo.Read(logger).Disconnected);
        pump.DisplayPowerChanged += power => UpdateSession(() => _displayPower = power);
        pump.SystemSuspendChanged += suspended => UpdateSession(() => _systemSuspended = suspended);
        pump.BatteryChanged += onBattery => UpdateSession(() => _onBattery = onBattery);
    }

    /// <summary>Reads the starting state, which notifications alone cannot provide.</summary>
    public void Start()
    {
        lock (_gate)
        {
            if (Kernel32.GetSystemPowerStatus(out var power))
            {
                _onBattery = power.ACLineStatus == 0;
            }

            // The engine can start on a locked screen, such as a restart after a crash.
            (_locked, _disconnected) = SessionInfo.Read(logger);

            RefreshDisplays();
            PublishSession();
            Evaluate();
        }
    }

    private void UpdateSession(Action change)
    {
        lock (_gate)
        {
            change();
            PublishSession();
        }
    }

    private void RefreshDisplays()
    {
        lock (_gate)
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
    }

    private void Evaluate()
    {
        lock (_gate)
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
    }

    private void PublishSession()
    {
        var session = new SessionState(_locked, _displayPower, _systemSuspended, _onBattery, false).WithExclusive(ReadExclusiveDevice());
        coordinator.UpdateSession(session with { SessionDisconnected = _disconnected, ScreenSaverRunning = ReadScreenSaverRunning() });
    }

    /// <summary>
    /// Windows has no event for this, but a screen saver runs on its own desktop, so starting
    /// and stopping raise the desktop-switch event that leads here.
    /// </summary>
    private static bool ReadScreenSaverRunning() =>
        User32.SystemParametersInfo(User32.SPI_GETSCREENSAVERRUNNING, 0, out var running, 0) && running != 0;

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

internal static unsafe class SessionInfo
{
    // In WTSINFOEXW the union holds a LARGE_INTEGER, so it starts at offset 8. SessionState and
    // SessionFlags are the second and third 32-bit fields inside it.
    private const int SessionStateOffset = 12;
    private const int SessionFlagsOffset = 16;

    /// <summary>The state of this session now. Unknown is reported as active and logged.</summary>
    public static (bool Locked, bool Disconnected) Read(StructuredLogger logger)
    {
        if (!Wtsapi32.WTSQuerySessionInformation(0, Wtsapi32.WTS_CURRENT_SESSION, Wtsapi32.WTSSessionInfoEx, out var buffer, out _))
        {
            logger.Warn("engine.session", "session.state-unavailable", new Dictionary<string, object?>
            {
                ["error"] = System.Runtime.InteropServices.Marshal.GetLastPInvokeError(),
            });
            return (false, false);
        }
        try
        {
            return (
                *(int*)(buffer + SessionFlagsOffset) == Wtsapi32.WTS_SESSIONSTATE_LOCK,
                *(int*)(buffer + SessionStateOffset) == Wtsapi32.WTSDisconnected);
        }
        finally
        {
            Wtsapi32.WTSFreeMemory(buffer);
        }
    }
}

internal static class SessionStateExtensions
{
    public static SessionState WithExclusive(this SessionState state, string? deviceName) =>
        state with { ExclusiveFullscreen = deviceName is not null, ExclusiveDeviceName = deviceName };
}
