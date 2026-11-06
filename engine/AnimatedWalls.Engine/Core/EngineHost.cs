using System.Diagnostics;
using System.Text.Json;
using System.Threading.Channels;
using AnimatedWalls.Engine.Desktop;
using AnimatedWalls.Engine.Diagnostics;
using AnimatedWalls.Engine.IPC;
using AnimatedWalls.Engine.Playback;
using AnimatedWalls.Engine.Rendering;
using AnimatedWalls.Engine.Visibility;

namespace AnimatedWalls.Engine.Core;

/// <summary>
/// Owns the engine's services and its lifetime. The engine runs while its parent does:
/// it exits on a shutdown request, when the authenticated client disconnects, or when
/// stdin closes. The stdin check means a crashed Electron cannot leave an orphan engine,
/// and it needs no polling and has no PID reuse problem.
/// </summary>
public sealed class EngineHost
{
    private const string LogSource = "engine.host";
    private static readonly TimeSpan GpuUsageWindow = TimeSpan.FromMilliseconds(500);

    private readonly string _pipeName;
    private readonly Stream _stdin;
    private readonly StructuredLogger _logger;
    private readonly CancellationTokenSource _shutdown = new();
    private readonly EngineCounters _counters = new();
    private readonly Stopwatch _uptime = Stopwatch.StartNew();
    private readonly Channel<EngineState> _stateEvents = Channel.CreateBounded<EngineState>(new BoundedChannelOptions(1)
    {
        // Only the latest state matters, so a slow client skips intermediate ones.
        FullMode = BoundedChannelFullMode.DropOldest,
        SingleReader = true,
    });

    private readonly Channel<GpuCapabilities> _gpuEvents = Channel.CreateBounded<GpuCapabilities>(new BoundedChannelOptions(1)
    {
        FullMode = BoundedChannelFullMode.DropOldest,
        SingleReader = true,
    });
    private volatile GpuCapabilities? _gpu;

    public EngineHost(string pipeName, Stream stdin, StructuredLogger logger)
    {
        _pipeName = pipeName;
        _stdin = stdin;
        _logger = logger;
    }

    public async Task<int> RunAsync(byte[] token)
    {
        _logger.Info(LogSource, "engine.start", new Dictionary<string, object?>
        {
            ["pid"] = Environment.ProcessId,
            ["version"] = EngineInfo.Version,
            ["protocol"] = EngineInfo.ProtocolVersion,
            ["os"] = Environment.OSVersion.VersionString,
            ["rendererImplemented"] = EngineInfo.RendererImplemented,
        });

        _gpu = DetectGpu();
        var coordinator = new PlaybackCoordinator(_logger, _counters, _gpu);
        coordinator.StateChanged += state => _stateEvents.Writer.TryWrite(state);

        using var pump = new DesktopSignalPump(_logger, _counters);
        var monitor = new VisibilityMonitor(pump, coordinator, _counters, _logger);
        monitor.Subscribe();

        using var renderer = new WallpaperRenderer(coordinator, _counters, _logger, () => _gpu!);
        pump.ExplorerRestarted += () =>
        {
            // Explorer took the wallpaper windows with it. Give its new desktop a moment to exist.
            _ = Task.Delay(TimeSpan.FromSeconds(1)).ContinueWith(_ => renderer.RebuildSurfaces(), TaskScheduler.Default);
        };
        // A driver update, a new GPU and Remote Desktop all change what hardware is usable, and
        // each of them either changes the displays or reconnects the session.
        pump.DisplaysDirty += () => RedetectGpu(coordinator);
        pump.SessionConnectionChanged += () => RedetectGpu(coordinator);
        pump.SessionEnding += () =>
        {
            _logger.Info(LogSource, "engine.session-ending");
            _shutdown.Cancel();
        };
        await pump.StartAsync().ConfigureAwait(false);

        var dispatcher = new RpcDispatcher();
        RegisterMethods(dispatcher, coordinator);

        using var server = new PipeServer(_pipeName, new SessionAuthenticator(token), dispatcher, _logger);
        server.ClientDisconnected += () =>
        {
            _logger.Info(LogSource, "engine.client-gone");
            _shutdown.Cancel();
        };
        server.Listen();

        // Evaluate only after the listener exists, so the first state has somewhere to go.
        monitor.Start();
        renderer.Start();

        // The supervisor waits for this line before connecting.
        Console.Out.WriteLine(JsonSerializer.Serialize(new ReadyMessage("engine.ready", _pipeName, Environment.ProcessId), ProtocolJson.Default.ReadyMessage));
        Console.Out.Flush();

        StartParentWatcher();
        var serverTask = server.RunAsync(_shutdown.Token);
        var eventsTask = ForwardEventsAsync(server, _shutdown.Token);

        var gpuEventsTask = ForwardGpuEventsAsync(server, _shutdown.Token);
        var exitCode = await RunUntilShutdownAsync(serverTask, eventsTask, gpuEventsTask).ConfigureAwait(false);

        _logger.Info(LogSource, "engine.exit", new Dictionary<string, object?>
        {
            ["exitCode"] = exitCode,
            ["uptimeMs"] = _uptime.ElapsedMilliseconds,
        });
        return exitCode;
    }

    /// <summary>
    /// Ends when any task ends, and takes the others down with it. Waiting for all of them
    /// would leave a half-dead engine running forever if just one of them failed.
    /// </summary>
    private async Task<int> RunUntilShutdownAsync(params Task[] tasks)
    {
        await Task.WhenAny(tasks).ConfigureAwait(false);
        _shutdown.Cancel();

        var exitCode = 0;
        foreach (var task in tasks)
        {
            try
            {
                await task.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // The normal way for these tasks to finish.
            }
            catch (Exception exception)
            {
                _logger.Error(LogSource, "engine.failed", exception);
                exitCode = 1;
            }
        }
        return exitCode;
    }

    private GpuCapabilities DetectGpu()
    {
        try
        {
            var gpu = GpuCapabilityDetector.Detect();
            _logger.Info("engine.rendering", "gpu.detected", new Dictionary<string, object?>
            {
                ["status"] = gpu.Status,
                ["selectedAdapter"] = gpu.SelectedAdapter?.Name,
                ["featureLevel"] = gpu.SelectedAdapter?.FeatureLevel,
                ["hardwareDecode"] = gpu.SelectedAdapter?.HardwareDecodeCodecs.ToArray(),
                ["adapters"] = gpu.Adapters.Select(adapter => $"{adapter.Name}: {adapter.RejectedReason ?? "usable"}").ToArray(),
                ["webView2"] = gpu.WebView2Version,
            });
            if (!gpu.IsSupported)
            {
                _logger.Error("engine.rendering", "gpu.unsupported", new Dictionary<string, object?> { ["reasons"] = gpu.UnsupportedReasons.ToArray() });
            }
            return gpu;
        }
        catch (Exception exception)
        {
            // A detection failure means playback must stay blocked, and the engine must
            // stay up so the UI can report why.
            _logger.Error("engine.rendering", "gpu.detection-failed", exception);
            return new GpuCapabilities("unsupported", null, [], [$"Graphics detection failed: {exception.Message}"], null, DateTimeOffset.UtcNow.ToString("O"));
        }
    }

    private void RedetectGpu(PlaybackCoordinator coordinator)
    {
        var previous = _gpu!;
        var next = DetectGpu();
        var same = previous.Status == next.Status
            && previous.SelectedAdapter?.Luid == next.SelectedAdapter?.Luid
            && previous.Adapters.Count == next.Adapters.Count;
        if (same) return;

        _logger.Info("engine.rendering", "gpu.changed", new Dictionary<string, object?>
        {
            ["from"] = previous.SelectedAdapter?.Name,
            ["to"] = next.SelectedAdapter?.Name,
            ["status"] = next.Status,
        });
        _gpu = next;
        coordinator.UpdateGpu(next);
        _gpuEvents.Writer.TryWrite(next);
    }

    private void RegisterMethods(RpcDispatcher dispatcher, PlaybackCoordinator coordinator)
    {
        var json = ProtocolJson.Default;

        dispatcher.Register("engine.health", json.EngineHealth, ReadHealth);
        dispatcher.Register("engine.capabilities", json.GpuCapabilities, () => _gpu!);
        dispatcher.Register("engine.state", json.EngineState, () => coordinator.Current);
        dispatcher.Register("engine.diagnostics", json.EngineDiagnostics, () => new EngineDiagnostics(
            ReadHealth(),
            coordinator.Current,
            _gpu!,
            GpuUsageSampler.Sample(Environment.ProcessId, GpuUsageWindow),
            DesktopHostLocator.Probe(),
            _logger.FilePath));
        dispatcher.Register("engine.shutdown", json.ShutdownResult, () =>
        {
            _logger.Info(LogSource, "engine.shutdown-requested");
            // Let the response leave before tearing the pipe down.
            _ = Task.Delay(50).ContinueWith(_ => _shutdown.Cancel(), TaskScheduler.Default);
            return new ShutdownResult(true);
        });

        dispatcher.Register("playback.setAssignments", json.SetAssignmentsParams, json.EngineState, parameters => coordinator.SetAssignments(parameters.Assignments));
        dispatcher.Register("playback.setPaused", json.SetPausedParams, json.EngineState, parameters => coordinator.SetPaused(parameters.Paused));
        dispatcher.Register("playback.configure", json.PlaybackConfig, json.EngineState, coordinator.Configure);
        dispatcher.Register("diagnostics.setLogLevel", json.SetLogLevelParams, json.SetLogLevelResult, parameters =>
        {
            if (!StructuredLogger.TryParseLevel(parameters.Level, out var level))
            {
                throw new RpcDispatcher.RpcFault(RpcErrorCodes.InvalidParams, $"Unknown log level '{parameters.Level}'.");
            }
            _logger.Level = level;
            return new SetLogLevelResult(parameters.Level.ToLowerInvariant());
        });
    }

    private EngineHealth ReadHealth()
    {
        using var process = Process.GetCurrentProcess();
        return new EngineHealth(
            Environment.ProcessId,
            EngineInfo.Version,
            EngineInfo.ProtocolVersion,
            _uptime.ElapsedMilliseconds,
            process.WorkingSet64,
            GC.GetTotalMemory(false),
            process.Threads.Count,
            EngineInfo.RendererImplemented,
            _counters.Snapshot());
    }

    private async Task ForwardGpuEventsAsync(PipeServer server, CancellationToken cancellationToken)
    {
        await foreach (var gpu in _gpuEvents.Reader.ReadAllAsync(cancellationToken).ConfigureAwait(false))
        {
            try
            {
                await server.SendEventAsync("gpu.changed", gpu, ProtocolJson.Default.GpuCapabilities, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is IOException or InvalidOperationException or ObjectDisposedException)
            {
                _logger.Warn("engine.ipc", "event.undeliverable", new Dictionary<string, object?> { ["message"] = exception.Message });
            }
        }
    }

    private async Task ForwardEventsAsync(PipeServer server, CancellationToken cancellationToken)
    {
        await foreach (var state in _stateEvents.Reader.ReadAllAsync(cancellationToken).ConfigureAwait(false))
        {
            try
            {
                await server.SendEventAsync("state.changed", state, ProtocolJson.Default.EngineState, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is IOException or InvalidOperationException or ObjectDisposedException)
            {
                // The client can vanish between the connection check and the write.
                _logger.Warn("engine.ipc", "event.undeliverable", new Dictionary<string, object?> { ["message"] = exception.Message });
            }
        }
    }

    /// <summary>
    /// Watches stdin on its own background thread, because reads on a console stream cannot
    /// be cancelled. A task awaiting one would never finish and would hold up shutdown; a
    /// background thread blocked in a read simply ends with the process.
    /// </summary>
    private void StartParentWatcher()
    {
        var thread = new Thread(() =>
        {
            var buffer = new byte[64];
            try
            {
                while (_stdin.Read(buffer, 0, buffer.Length) > 0)
                {
                    // Nothing is sent after the token. Only the end of the stream matters.
                }
                _logger.Info(LogSource, "engine.parent-gone");
            }
            catch (Exception exception) when (exception is IOException or ObjectDisposedException)
            {
                _logger.Warn(LogSource, "engine.parent-pipe-failed", new Dictionary<string, object?> { ["message"] = exception.Message });
            }
            _shutdown.Cancel();
        })
        {
            IsBackground = true,
            Name = "ParentWatcher",
        };
        thread.Start();
    }

}
