using System.Runtime.InteropServices;
using AnimatedWalls.Engine.Core;
using AnimatedWalls.Engine.Diagnostics;

namespace AnimatedWalls.Engine.Visibility;

/// <summary>
/// Owns a message-pump thread and turns Windows notifications into engine signals.
/// Everything is event driven: while nothing changes on the desktop, this thread
/// sleeps in GetMessage and the engine evaluates nothing.
///
/// The window is a hidden top-level window, not a message-only (HWND_MESSAGE) window.
/// Message-only windows do not receive broadcasts, and WM_DISPLAYCHANGE,
/// WM_SETTINGCHANGE and the "TaskbarCreated" message are all broadcasts.
/// </summary>
public sealed unsafe class DesktopSignalPump : IDisposable
{
    private const uint WM_DESTROY = 0x0002;
    private const uint WM_SETTINGCHANGE = 0x001A;
    private const uint WM_QUERYENDSESSION = 0x0011;
    private const uint WM_ENDSESSION = 0x0016;
    private const uint WM_DISPLAYCHANGE = 0x007E;
    private const uint WM_TIMER = 0x0113;
    private const uint WM_POWERBROADCAST = 0x0218;
    private const uint WM_WTSSESSION_CHANGE = 0x02B1;
    private const uint WM_DPICHANGED = 0x02E0;
    private const uint WM_APP_STOP = 0x8001;
    private const uint WM_APP_REFRESH = 0x8002;

    private const nint WTS_SESSION_LOCK = 7;
    private const nint WTS_SESSION_UNLOCK = 8;
    private const nint PBT_APMSUSPEND = 4;
    private const nint PBT_APMRESUMESUSPEND = 7;
    private const nint PBT_APMRESUMEAUTOMATIC = 0x12;
    private const nint PBT_POWERSETTINGCHANGE = 0x8013;
    private const nint SPI_SETWORKAREA = 0x2F;

    private const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    private const uint EVENT_SYSTEM_MOVESIZEEND = 0x000B;
    private const uint EVENT_SYSTEM_MINIMIZESTART = 0x0016;
    private const uint EVENT_SYSTEM_MINIMIZEEND = 0x0017;
    private const uint EVENT_SYSTEM_DESKTOPSWITCH = 0x0020;
    private const uint EVENT_OBJECT_DESTROY = 0x8001;
    private const uint EVENT_OBJECT_SHOW = 0x8002;
    private const uint EVENT_OBJECT_HIDE = 0x8003;
    private const uint EVENT_OBJECT_REORDER = 0x8004;
    private const uint EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
    private const uint EVENT_OBJECT_CLOAKED = 0x8017;
    private const uint EVENT_OBJECT_UNCLOAKED = 0x8018;
    private const int OBJID_WINDOW = 0;
    private const int CHILDID_SELF = 0;

    private const nuint VisibilityTimerId = 1;
    private const nuint DisplayTimerId = 2;
    private const uint VisibilityThrottleMs = 80;
    // Display changes arrive in bursts while Windows reconfigures, and the layout is
    // only trustworthy once they stop.
    private const uint DisplaySettleMs = 300;

    private static readonly Guid GuidSessionDisplayStatus = new("2B84C20E-AD23-4DDF-93DB-05FFBD7EFCA5");
    private static readonly Guid GuidAcDcPowerSource = new("5D3E9A59-E9D5-4B00-A6BD-FF34FF516548");

    private static DesktopSignalPump? _instance;
    private static int _classRegistered;

    private readonly StructuredLogger _logger;
    private readonly EngineCounters _counters;
    private readonly TaskCompletionSource _started = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly List<nint> _hooks = [];
    private readonly List<nint> _powerNotifications = [];
    private Thread? _thread;
    private nint _window;
    private uint _taskbarCreatedMessage;
    private bool _visibilityTimerArmed;

    /// <summary>The visible windows may have changed. Throttled, on the pump thread.</summary>
    public event Action? VisibilityDirty;
    /// <summary>The monitor layout may have changed. Debounced, on the pump thread.</summary>
    public event Action? DisplaysDirty;
    public event Action<bool>? SessionLockChanged;
    public event Action<string>? DisplayPowerChanged;
    public event Action<bool>? SystemSuspendChanged;
    public event Action<bool>? BatteryChanged;
    /// <summary>Explorer restarted, so any window parented to the desktop was lost.</summary>
    public event Action? ExplorerRestarted;
    public event Action? SessionEnding;

    public DesktopSignalPump(StructuredLogger logger, EngineCounters counters)
    {
        _logger = logger;
        _counters = counters;
    }

    public Task StartAsync()
    {
        if (Interlocked.CompareExchange(ref _instance, this, null) is not null)
        {
            throw new InvalidOperationException("Only one DesktopSignalPump can run in a process.");
        }
        _thread = new Thread(PumpThread) { IsBackground = true, Name = "DesktopSignalPump" };
        _thread.SetApartmentState(ApartmentState.STA);
        _thread.Start();
        return _started.Task;
    }

    /// <summary>Asks the pump thread to re-evaluate visibility soon.</summary>
    public void RequestRefresh()
    {
        if (_window != 0) User32.PostMessage(_window, WM_APP_REFRESH, 0, 0);
    }

    private void PumpThread()
    {
        try
        {
            CreateSignalWindow();
            RegisterNotifications();
            InstallWinEventHooks();
            _started.TrySetResult();

            while (User32.GetMessage(out var message, 0, 0, 0) > 0)
            {
                User32.TranslateMessage(message);
                User32.DispatchMessage(message);
            }
        }
        catch (Exception exception)
        {
            _logger.Error("engine.visibility", "signal-pump.failed", exception);
            _started.TrySetException(exception);
        }
        finally
        {
            Cleanup();
        }
    }

    private void CreateSignalWindow()
    {
        const string className = "AnimatedWallsEngineSignals";
        var instance = Kernel32.GetModuleHandle(null);

        if (Interlocked.Exchange(ref _classRegistered, 1) == 0)
        {
            fixed (char* namePointer = className)
            {
                var windowClass = new WindowClassEx
                {
                    Size = (uint)sizeof(WindowClassEx),
                    WndProc = &WindowProc,
                    Instance = instance,
                    ClassName = namePointer,
                };
                if (User32.RegisterClassEx(&windowClass) == 0)
                {
                    throw new InvalidOperationException($"RegisterClassEx failed with error {Marshal.GetLastPInvokeError()}.");
                }
            }
        }

        _window = User32.CreateWindowEx(
            User32.WS_EX_TOOLWINDOW | User32.WS_EX_NOACTIVATE,
            className, "Animated Walls Engine", User32.WS_POPUP,
            0, 0, 0, 0, 0, 0, instance, 0);
        if (_window == 0)
        {
            throw new InvalidOperationException($"CreateWindowEx failed with error {Marshal.GetLastPInvokeError()}.");
        }

        _taskbarCreatedMessage = User32.RegisterWindowMessage("TaskbarCreated");
    }

    private void RegisterNotifications()
    {
        if (!Wtsapi32.WTSRegisterSessionNotification(_window, Wtsapi32.NOTIFY_FOR_THIS_SESSION))
        {
            _logger.Warn("engine.visibility", "session-notification.unavailable", new Dictionary<string, object?>
            {
                ["error"] = Marshal.GetLastPInvokeError(),
            });
        }

        foreach (var setting in new[] { GuidSessionDisplayStatus, GuidAcDcPowerSource })
        {
            // Flag 0 is DEVICE_NOTIFY_WINDOW_HANDLE. Windows sends the current value
            // straight away, which is how the initial display power state is learned.
            var handle = User32.RegisterPowerSettingNotification(_window, setting, 0);
            if (handle == 0)
            {
                _logger.Warn("engine.visibility", "power-notification.unavailable", new Dictionary<string, object?>
                {
                    ["setting"] = setting.ToString(),
                    ["error"] = Marshal.GetLastPInvokeError(),
                });
            }
            else
            {
                _powerNotifications.Add(handle);
            }
        }
    }

    private void InstallWinEventHooks()
    {
        // WINEVENT_OUTOFCONTEXT injects nothing into other processes, so this is safe
        // around anti-cheat systems, and callbacks arrive on this thread.
        (uint Min, uint Max)[] ranges =
        [
            (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),
            (EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZEEND),
            (EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND),
            (EVENT_SYSTEM_DESKTOPSWITCH, EVENT_SYSTEM_DESKTOPSWITCH),
            (EVENT_OBJECT_DESTROY, EVENT_OBJECT_REORDER),
            (EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE),
            (EVENT_OBJECT_CLOAKED, EVENT_OBJECT_UNCLOAKED),
        ];

        foreach (var (min, max) in ranges)
        {
            var hook = User32.SetWinEventHook(min, max, 0, &WinEventCallback, 0, 0, User32.WINEVENT_OUTOFCONTEXT | User32.WINEVENT_SKIPOWNPROCESS);
            if (hook == 0)
            {
                throw new InvalidOperationException($"SetWinEventHook failed for 0x{min:X}-0x{max:X}.");
            }
            _hooks.Add(hook);
        }
    }

    [UnmanagedCallersOnly]
    private static void WinEventCallback(nint hook, uint eventType, nint hwnd, int idObject, int idChild, uint thread, uint time)
    {
        _instance?.OnWinEvent(eventType, hwnd, idObject, idChild);
    }

    private void OnWinEvent(uint eventType, nint hwnd, int idObject, int idChild)
    {
        _counters.WinEventReceived();

        // Desktop switches (including the secure desktop) carry no window.
        if (eventType != EVENT_SYSTEM_DESKTOPSWITCH)
        {
            // Cursors, carets and child controls generate a torrent of location events,
            // so drop everything but whole windows before doing any work.
            if (idObject != OBJID_WINDOW || idChild != CHILDID_SELF || hwnd == 0) return;
            if (User32.GetAncestor(hwnd, User32.GA_ROOT) != hwnd) return;
        }

        ArmVisibilityTimer();
    }

    private void ArmVisibilityTimer()
    {
        // A throttle rather than a debounce. Restarting the timer on each event would
        // starve evaluation for as long as a window is being dragged.
        if (_visibilityTimerArmed) return;
        _visibilityTimerArmed = true;
        User32.SetTimer(_window, VisibilityTimerId, VisibilityThrottleMs, 0);
    }

    [UnmanagedCallersOnly]
    private static nint WindowProc(nint hwnd, uint message, nint wParam, nint lParam)
    {
        var instance = _instance;
        if (instance is null) return User32.DefWindowProc(hwnd, message, wParam, lParam);
        try
        {
            return instance.HandleMessage(hwnd, message, wParam, lParam);
        }
        catch (Exception exception)
        {
            // An exception must not cross into native code, or the process dies with no
            // usable diagnostics.
            instance._logger.Error("engine.visibility", "window-proc.failed", exception);
            return 0;
        }
    }

    private nint HandleMessage(nint hwnd, uint message, nint wParam, nint lParam)
    {
        switch (message)
        {
            case WM_TIMER when wParam == (nint)VisibilityTimerId:
                User32.KillTimer(hwnd, VisibilityTimerId);
                _visibilityTimerArmed = false;
                VisibilityDirty?.Invoke();
                return 0;

            case WM_TIMER when wParam == (nint)DisplayTimerId:
                User32.KillTimer(hwnd, DisplayTimerId);
                DisplaysDirty?.Invoke();
                VisibilityDirty?.Invoke();
                return 0;

            case WM_APP_REFRESH:
                ArmVisibilityTimer();
                return 0;

            case WM_APP_STOP:
                User32.DestroyWindow(hwnd);
                return 0;

            case WM_DESTROY:
                User32.PostQuitMessage(0);
                return 0;

            case WM_DISPLAYCHANGE:
            case WM_DPICHANGED:
                ScheduleDisplayRefresh(hwnd);
                return 0;

            case WM_SETTINGCHANGE when wParam == SPI_SETWORKAREA:
                ScheduleDisplayRefresh(hwnd);
                return 0;

            case WM_WTSSESSION_CHANGE:
                if (wParam == WTS_SESSION_LOCK) SessionLockChanged?.Invoke(true);
                else if (wParam == WTS_SESSION_UNLOCK) SessionLockChanged?.Invoke(false);
                return 0;

            case WM_POWERBROADCAST:
                HandlePower(wParam, lParam);
                return 1;

            case WM_QUERYENDSESSION:
                return 1;

            case WM_ENDSESSION:
                if (wParam != 0) SessionEnding?.Invoke();
                return 0;
        }

        if (message == _taskbarCreatedMessage && _taskbarCreatedMessage != 0)
        {
            _logger.Info("engine.desktop", "explorer.restarted");
            ExplorerRestarted?.Invoke();
            ArmVisibilityTimer();
            return 0;
        }

        return User32.DefWindowProc(hwnd, message, wParam, lParam);
    }

    private void ScheduleDisplayRefresh(nint hwnd) => User32.SetTimer(hwnd, DisplayTimerId, DisplaySettleMs, 0);

    private void HandlePower(nint eventType, nint data)
    {
        if (eventType == PBT_APMSUSPEND)
        {
            SystemSuspendChanged?.Invoke(true);
        }
        else if (eventType == PBT_APMRESUMEAUTOMATIC || eventType == PBT_APMRESUMESUSPEND)
        {
            SystemSuspendChanged?.Invoke(false);
        }
        else if (eventType == PBT_POWERSETTINGCHANGE && data != 0)
        {
            var setting = (PowerBroadcastSetting*)data;
            if (setting->DataLength < 1) return;

            if (setting->PowerSetting == GuidSessionDisplayStatus)
            {
                DisplayPowerChanged?.Invoke(setting->Data switch
                {
                    0 => DisplayPowerStates.Off,
                    1 => DisplayPowerStates.On,
                    2 => DisplayPowerStates.Dimmed,
                    _ => DisplayPowerStates.Unknown,
                });
            }
            else if (setting->PowerSetting == GuidAcDcPowerSource)
            {
                // 0 = AC, 1 = battery, 2 = short-term source such as a UPS.
                BatteryChanged?.Invoke(setting->Data != 0);
            }
        }
    }

    private void Cleanup()
    {
        foreach (var hook in _hooks) User32.UnhookWinEvent(hook);
        _hooks.Clear();
        foreach (var handle in _powerNotifications) User32.UnregisterPowerSettingNotification(handle);
        _powerNotifications.Clear();
        if (_window != 0) Wtsapi32.WTSUnRegisterSessionNotification(_window);
        _window = 0;
        Interlocked.CompareExchange(ref _instance, null, this);
    }

    public void Dispose()
    {
        if (_window != 0) User32.PostMessage(_window, WM_APP_STOP, 0, 0);
        if (_thread is { IsAlive: true } thread && !thread.Join(TimeSpan.FromSeconds(2)))
        {
            _logger.Warn("engine.visibility", "signal-pump.stop-timeout");
        }
    }
}
