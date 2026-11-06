using AnimatedWalls.Engine.Core;
using AnimatedWalls.Engine.Diagnostics;
using AnimatedWalls.Engine.Playback;
using Vortice.MediaFoundation;

namespace AnimatedWalls.Engine.Rendering;

/// <summary>
/// Makes the surfaces on the desktop match the coordinator's decisions. It owns no policy: when
/// the coordinator says a display should render, a surface plays, and when it says suspended, the
/// surface stops presenting and decoding. It works on its own thread because creating and
/// destroying surfaces can take a moment, and the coordinator is called from the signal pump.
/// </summary>
public sealed class WallpaperRenderer : IDisposable
{
    private const string LogSource = "engine.rendering";

    private readonly PlaybackCoordinator _coordinator;
    private readonly EngineCounters _counters;
    private readonly StructuredLogger _logger;
    private readonly Func<GpuCapabilities> _gpu;
    private readonly Dictionary<string, (string Key, WallpaperSurface Surface)> _surfaces = new(StringComparer.Ordinal);
    private readonly AutoResetEvent _changed = new(false);
    private readonly Thread _thread;
    private volatile bool _stopping;
    private int _generation;
    private bool _started;

    public WallpaperRenderer(PlaybackCoordinator coordinator, EngineCounters counters, StructuredLogger logger, Func<GpuCapabilities> gpu)
    {
        _coordinator = coordinator;
        _counters = counters;
        _logger = logger;
        _gpu = gpu;
        _thread = new Thread(Run) { IsBackground = true, Name = "WallpaperRenderer" };
    }

    public void Start()
    {
        var result = MediaFactory.MFStartup(false);
        result.CheckError();
        _started = true;
        _coordinator.StateChanged += _ => _changed.Set();
        _thread.Start();
    }

    /// <summary>Rebuilds every surface, for when Explorer restarted and took them with it.</summary>
    public void RebuildSurfaces()
    {
        Interlocked.Increment(ref _generation);
        _changed.Set();
    }

    private void Run()
    {
        while (!_stopping)
        {
            try
            {
                Reconcile();
            }
            catch (Exception exception)
            {
                // A failure here must not silently end wallpaper management for good.
                _logger.Error(LogSource, "renderer.reconcile-failed", exception);
            }
            _changed.WaitOne();
        }

        foreach (var (_, surface) in _surfaces.Values) surface.Dispose();
        _surfaces.Clear();
    }

    private void Reconcile()
    {
        var state = _coordinator.Current;
        var config = _coordinator.Config;
        var gpu = _gpu();
        var generation = Volatile.Read(ref _generation);

        foreach (var render in state.Render)
        {
            var display = state.Displays.FirstOrDefault(item => item.Id == render.DisplayId);
            var assignment = _coordinator.AssignmentFor(render.DisplayId);
            var adapter = display is null ? null : AdapterFor(gpu, display);

            var wanted = display is not null
                && adapter is not null
                && assignment is { MediaPath: not null, MediaType: DisplayAssignment.VideoType }
                && render.Decision is RenderDecisions.Render or RenderDecisions.Suspended;

            if (!wanted)
            {
                RemoveSurface(render.DisplayId);
                continue;
            }

            var key = $"{generation}|{assignment!.MediaPath}|{display!.Bounds}|{adapter!.Luid}|{config.Quality}";
            if (_surfaces.TryGetValue(render.DisplayId, out var existing) && existing.Key != key)
            {
                RemoveSurface(render.DisplayId);
                existing = default;
            }

            var playing = render.Decision == RenderDecisions.Render;
            if (existing.Surface is null)
            {
                // A display starting out covered creates nothing, so decodes nothing, until it shows.
                if (!playing) continue;

                var displayId = render.DisplayId;
                var surface = new WallpaperSurface(
                    new SurfaceOptions(display, assignment.MediaPath!, adapter, config.FrameRateLimit, config.Quality),
                    _counters,
                    _logger,
                    (failure, message) => _coordinator.ReportFailure(
                        displayId,
                        failure == SurfaceFailure.NoHardwareDecode ? RenderReasons.NoHardwareDecode : RenderReasons.PlaybackFailed,
                        message));
                _surfaces[displayId] = (key, surface);
                existing = _surfaces[displayId];
            }

            existing.Surface.SetFrameRateLimit(config.FrameRateLimit);
            existing.Surface.SetPlaying(playing);
        }

        foreach (var gone in _surfaces.Keys.Where(id => state.Render.All(render => render.DisplayId != id)).ToArray())
        {
            RemoveSurface(gone);
        }
    }

    private void RemoveSurface(string displayId)
    {
        if (!_surfaces.Remove(displayId, out var entry)) return;
        entry.Surface.Dispose();
    }

    /// <summary>The adapter driving this display if usable, since presenting from it needs no copy.</summary>
    private static GpuAdapter? AdapterFor(GpuCapabilities gpu, DisplayInfo display) =>
        gpu.Adapters.FirstOrDefault(adapter => adapter.RejectedReason is null && adapter.ConnectedOutputs.Contains(display.DeviceName, StringComparer.OrdinalIgnoreCase))
        ?? gpu.SelectedAdapter;

    /// <summary>Stops everything. The desktop shows the normal Windows wallpaper again.</summary>
    public void Dispose()
    {
        _stopping = true;
        _changed.Set();
        if (_started)
        {
            if (!_thread.Join(TimeSpan.FromSeconds(8))) _logger.Warn(LogSource, "renderer.stop-timeout");
            var result = MediaFactory.MFShutdown();
            if (result.Failure) _logger.Warn(LogSource, "renderer.mf-shutdown-failed", new Dictionary<string, object?> { ["code"] = result.Code });
        }
    }
}
