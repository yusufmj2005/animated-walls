using AnimatedWalls.Engine.Core;
using AnimatedWalls.Engine.Diagnostics;

namespace AnimatedWalls.Engine.Playback;

/// <summary>
/// Holds what is known about displays, visibility, the session and user choices, and
/// turns it into one render state per display. It raises <see cref="StateChanged"/>
/// only for changes that matter, so dragging a window does not flood the UI.
/// </summary>
public sealed class PlaybackCoordinator(StructuredLogger logger, EngineCounters counters, GpuCapabilities gpu)
{
    private const string LogSource = "engine.playback";
    private const double SignificantFractionChange = 0.05;

    private readonly object _gate = new();
    private readonly Dictionary<string, string> _assignments = new(StringComparer.Ordinal);
    private readonly Dictionary<string, DisplayRenderState> _renderStates = new(StringComparer.Ordinal);
    private IReadOnlyList<DisplayInfo> _displays = [];
    private IReadOnlyList<DisplayVisibility> _visibility = [];
    private SessionState _session = new(false, DisplayPowerStates.Unknown, false, false, false);
    private PlaybackConfig _config = PlaybackConfig.Default;
    private bool _paused;
    private GpuCapabilities _gpu = gpu;
    private EngineState? _current;
    private EngineState? _lastPublished;

    public event Action<EngineState>? StateChanged;

    public EngineState Current
    {
        get
        {
            lock (_gate) return _current ?? Compose();
        }
    }

    public void UpdateDisplays(IReadOnlyList<DisplayInfo> displays)
    {
        lock (_gate)
        {
            if (!displays.SequenceEqual(_displays))
            {
                logger.Info(LogSource, "displays.changed", new Dictionary<string, object?>
                {
                    ["count"] = displays.Count,
                    ["displays"] = displays.Select(display => $"{display.FriendlyName} {display.Bounds.Width}x{display.Bounds.Height}@{display.RefreshRateHz}Hz").ToArray(),
                });
            }
            _displays = displays;
            Recompute(force: true);
        }
    }

    public void UpdateVisibility(IReadOnlyList<DisplayVisibility> visibility)
    {
        lock (_gate)
        {
            foreach (var next in visibility)
            {
                var previous = _visibility.FirstOrDefault(item => item.DisplayId == next.DisplayId);
                if (previous?.State != next.State)
                {
                    logger.Info("engine.visibility", "visibility.changed", new Dictionary<string, object?>
                    {
                        ["displayId"] = next.DisplayId,
                        ["from"] = previous?.State,
                        ["to"] = next.State,
                        ["visibleFraction"] = next.VisibleFraction,
                        ["topOccluder"] = next.TopOccluderClass,
                    });
                }
            }
            _visibility = visibility;
            Recompute(force: false);
        }
    }

    public void UpdateSession(SessionState session)
    {
        lock (_gate)
        {
            if (session == _session) return;
            logger.Info("engine.session", "session.changed", new Dictionary<string, object?>
            {
                ["locked"] = session.Locked,
                ["displayPower"] = session.DisplayPower,
                ["systemSuspended"] = session.SystemSuspended,
                ["onBattery"] = session.OnBattery,
                ["exclusiveFullscreen"] = session.ExclusiveFullscreen,
                ["sessionDisconnected"] = session.SessionDisconnected,
                ["screenSaverRunning"] = session.ScreenSaverRunning,
            });
            _session = session;
            Recompute(force: true);
        }
    }

    /// <summary>The graphics hardware changed, such as after a driver update.</summary>
    public void UpdateGpu(GpuCapabilities gpu)
    {
        lock (_gate)
        {
            _gpu = gpu;
            Recompute(force: true);
        }
    }

    public EngineState SetAssignments(IEnumerable<DisplayAssignment> assignments)
    {
        lock (_gate)
        {
            _assignments.Clear();
            foreach (var assignment in assignments) _assignments[assignment.DisplayId] = assignment.WallpaperId;
            Recompute(force: true);
            return _current!;
        }
    }

    public EngineState SetPaused(bool paused)
    {
        lock (_gate)
        {
            _paused = paused;
            Recompute(force: true);
            return _current!;
        }
    }

    public EngineState Configure(PlaybackConfig config)
    {
        lock (_gate)
        {
            _config = config;
            logger.Info(LogSource, "playback.configured", new Dictionary<string, object?>
            {
                ["frameRateLimit"] = config.FrameRateLimit,
                ["quality"] = config.Quality,
                ["pauseOnBattery"] = config.PauseOnBattery,
            });
            Recompute(force: true);
            return _current!;
        }
    }

    private void Recompute(bool force)
    {
        var next = Compose();
        _current = next;

        // Compared with what was last sent, not with the last evaluation. Otherwise a slow drag
        // that changes visibility by 1% each step never counts as a change, however far it goes.
        if (force || _lastPublished is null || HasSignificantChange(_lastPublished, next))
        {
            _lastPublished = next;
            StateChanged?.Invoke(next);
        }
    }

    private static bool HasSignificantChange(EngineState previous, EngineState next)
    {
        if (!previous.Render.SequenceEqual(next.Render)) return true;
        if (previous.Visibility.Count != next.Visibility.Count) return true;
        for (var index = 0; index < next.Visibility.Count; index++)
        {
            var before = previous.Visibility[index];
            var after = next.Visibility[index];
            if (before.DisplayId != after.DisplayId || before.State != after.State) return true;
            if (Math.Abs(before.VisibleFraction - after.VisibleFraction) >= SignificantFractionChange) return true;
        }
        return false;
    }

    private EngineState Compose()
    {
        var render = new List<DisplayRenderState>(_displays.Count);
        foreach (var display in _displays)
        {
            _assignments.TryGetValue(display.Id, out var wallpaperId);
            var visibility = _visibility.FirstOrDefault(item => item.DisplayId == display.Id)?.State ?? VisibilityStates.Visible;

            var (decision, reason) = RenderPolicy.Decide(new RenderPolicy.Inputs(
                wallpaperId,
                visibility,
                _session,
                _session.ExclusiveFullscreen && string.Equals(_session.ExclusiveDeviceName, display.DeviceName, StringComparison.OrdinalIgnoreCase),
                _gpu.IsSupported,
                _paused,
                _config.PauseOnBattery));

            _renderStates.TryGetValue(display.Id, out var previous);
            DisplayRenderState state;
            if (previous is not null && previous.Decision == decision && previous.Reason == reason && previous.WallpaperId == wallpaperId)
            {
                state = previous;
            }
            else
            {
                state = new DisplayRenderState(display.Id, decision, reason, wallpaperId, DateTimeOffset.UtcNow.ToString("O"));
                _renderStates[display.Id] = state;
                counters.RenderTransition();
                logger.Info("engine.rendering", "render.transition", new Dictionary<string, object?>
                {
                    ["displayId"] = display.Id,
                    ["from"] = previous?.Decision,
                    ["to"] = decision,
                    ["reason"] = reason,
                    ["wallpaperId"] = wallpaperId,
                    ["rendererImplemented"] = EngineInfo.RendererImplemented,
                });
            }
            render.Add(state);
        }

        // Forget displays that were unplugged, or a stale state would resurface on replug.
        foreach (var stale in _renderStates.Keys.Where(id => _displays.All(display => display.Id != id)).ToArray())
        {
            _renderStates.Remove(stale);
        }

        return new EngineState(_displays, _visibility, _session, render, _paused);
    }
}
