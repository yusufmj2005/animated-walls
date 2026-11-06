using AnimatedWalls.Engine.Core;
using AnimatedWalls.Engine.Desktop;
using AnimatedWalls.Engine.Diagnostics;
using AnimatedWalls.Engine.Displays;
using AnimatedWalls.Engine.Rendering;
using Vortice.MediaFoundation;
using Xunit;

namespace AnimatedWalls.Engine.Tests;

/// <summary>
/// The product's main promise, measured on real hardware: frames while playing, and exactly none
/// while suspended. These draw a test video behind the desktop icons for a few seconds, and they
/// control the surface directly, so they work whatever windows happen to be open.
/// </summary>
[Trait("Category", "Desktop")]
[Collection("Desktop")]
public sealed class WallpaperSurfaceTests : IDisposable
{
    private readonly DisplayInfo _display = DisplayEnumerator.Enumerate().First(item => item.IsPrimary);
    private readonly GpuCapabilities _gpu = GpuCapabilityDetector.Detect();
    private readonly EngineCounters _counters = new();
    private readonly StructuredLogger _logger = new(null, level: LogLevel.Error);
    private readonly List<string> _failures = [];

    public WallpaperSurfaceTests()
    {
        Assert.True(MediaFactory.MFStartup(false).Success);
    }

    public void Dispose()
    {
        MediaFactory.MFShutdown();
        _logger.Dispose();
    }

    private static string Fixture()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "apps", "desktop", "test", "fixtures", "sample-h264.mp4");
            if (File.Exists(candidate)) return candidate;
        }
        throw new FileNotFoundException("The H.264 test clip was not found.");
    }

    private WallpaperSurface Surface(string? path = null, int frameRateLimit = 0, TimeSpan? releaseAfter = null)
    {
        Assert.SkipWhen(_gpu.SelectedAdapter is null, "This test needs a GPU.");
        return new WallpaperSurface(
            new SurfaceOptions(_display, path ?? Fixture(), _gpu.SelectedAdapter!, frameRateLimit, "high", releaseAfter),
            _counters,
            _logger,
            (failure, message) =>
            {
                lock (_failures) _failures.Add($"{failure}: {message}");
            });
    }

    private async Task WaitForFrames(long atLeast, int timeoutMs = 8000)
    {
        var started = Environment.TickCount64;
        while (_counters.Snapshot().FramesPresented < atLeast)
        {
            lock (_failures) Assert.True(_failures.Count == 0, string.Join("; ", _failures));
            Assert.True(Environment.TickCount64 - started < timeoutMs, $"Only {_counters.Snapshot().FramesPresented} frames were presented.");
            await Task.Delay(50, TestContext.Current.CancellationToken);
        }
    }

    [Fact]
    public async Task Video_plays_on_the_gpu_and_stops_completely_when_suspended()
    {
        using var surface = Surface();
        surface.SetPlaying(true);
        await WaitForFrames(30);

        // Playing: real frames, with this process's video engine busy.
        var playing = GpuUsageSampler.Sample(Environment.ProcessId, TimeSpan.FromSeconds(1));
        Assert.True(playing.Available, playing.Error);
        Assert.True(playing.VideoDecodePercent > 0, $"The GPU video engine read {playing.VideoDecodePercent}% while playing.");
        Assert.True(_counters.Snapshot().FramesDecoded > 30);

        surface.SetPlaying(false);
        await Task.Delay(400, TestContext.Current.CancellationToken);

        // Suspended: exact counters first, then the GPU's own view of this process.
        var before = _counters.Snapshot();
        var suspended = GpuUsageSampler.Sample(Environment.ProcessId, TimeSpan.FromSeconds(2));
        var after = _counters.Snapshot();
        Assert.Equal(before.FramesPresented, after.FramesPresented);
        Assert.Equal(before.FramesDecoded, after.FramesDecoded);
        Assert.Equal(0, suspended.VideoDecodePercent);
        Assert.Equal(0, suspended.Engine3DPercent);

        // Resuming: frames come back.
        surface.SetPlaying(true);
        await WaitForFrames(after.FramesPresented + 15);
        lock (_failures) Assert.Empty(_failures);
    }

    [Fact]
    public async Task Frames_reach_the_desktop_and_the_normal_wallpaper_returns_afterwards()
    {
        var progman = User32.FindWindow("Progman", null);
        Assert.NotEqual((nint)0, progman);
        var point = (X: _display.Bounds.X + _display.Bounds.Width * 3 / 4, Y: _display.Bounds.Y + _display.Bounds.Height / 2);
        using var reader = new HostingProofOfConcept.DesktopPixelReader(progman, point);
        Assert.Equal("dwm-thumbnail", reader.Method);
        var wallpaper = reader.Read();

        using (var surface = Surface())
        {
            surface.SetPlaying(true);
            await WaitForFrames(30);

            var seen = new HashSet<string?>();
            for (var sample = 0; sample < 12; sample++)
            {
                seen.Add(reader.Read());
                await Task.Delay(150, TestContext.Current.CancellationToken);
            }
            Assert.DoesNotContain(wallpaper, seen);
            Assert.True(seen.Count > 2, $"The picture did not change: {string.Join(",", seen)}");
        }

        await Task.Delay(500, TestContext.Current.CancellationToken);
        var restored = reader.Read()!;
        Assert.True(ColorDistance(wallpaper!, restored) < 16, $"Expected about {wallpaper} after stopping, read {restored}.");
    }

    private static int ColorDistance(string a, string b)
    {
        int Channel(string text, int at) => Convert.ToInt32(text.Substring(at, 2), 16);
        return new[] { 1, 3, 5 }.Max(at => Math.Abs(Channel(a, at) - Channel(b, at)));
    }

    [Fact]
    public async Task A_30_fps_video_is_not_presented_at_the_display_rate()
    {
        using var surface = Surface();
        surface.SetPlaying(true);
        await WaitForFrames(5);
        var start = _counters.Snapshot();
        await Task.Delay(2000, TestContext.Current.CancellationToken);
        var end = _counters.Snapshot();

        // At 60 Hz, presenting every vblank would give about 120 here. The clip is 30 fps.
        Assert.InRange(end.FramesPresented - start.FramesPresented, 40, 75);
        Assert.InRange(end.FramesDecoded - start.FramesDecoded, 40, 75);
    }

    [Fact]
    public async Task The_frame_rate_limit_is_respected()
    {
        using var surface = Surface(frameRateLimit: 15);
        surface.SetPlaying(true);
        await WaitForFrames(5);
        var start = _counters.Snapshot();
        await Task.Delay(2000, TestContext.Current.CancellationToken);
        var presented = _counters.Snapshot().FramesPresented - start.FramesPresented;
        Assert.InRange(presented, 20, 36);
    }

    [Fact]
    public async Task A_long_suspension_releases_the_decoder_and_resuming_recreates_it()
    {
        using var surface = Surface(releaseAfter: TimeSpan.FromMilliseconds(300));
        surface.SetPlaying(true);
        await WaitForFrames(15);
        Assert.True(surface.IsMediaLoaded);

        surface.SetPlaying(false);
        await Task.Delay(900, TestContext.Current.CancellationToken);
        Assert.False(surface.IsMediaLoaded);

        var frames = _counters.Snapshot().FramesPresented;
        surface.SetPlaying(true);
        await WaitForFrames(frames + 15);
        Assert.True(surface.IsMediaLoaded);
    }

    [Fact]
    public async Task Hardware_decoding_is_measured_and_confirmed_while_playing()
    {
        using var surface = Surface();
        surface.SetPlaying(true);
        var started = Environment.TickCount64;
        while (!surface.IsHardwareDecodeVerified && Environment.TickCount64 - started < 12000)
        {
            await Task.Delay(100, TestContext.Current.CancellationToken);
        }
        Assert.True(surface.IsHardwareDecodeVerified);
        lock (_failures) Assert.Empty(_failures);
    }

    [Fact]
    public async Task A_file_that_is_not_a_video_fails_and_reports_why()
    {
        var path = Path.Combine(Path.GetTempPath(), $"awall-not-a-video-{Guid.NewGuid():N}.mp4");
        await File.WriteAllTextAsync(path, "this is not a video", TestContext.Current.CancellationToken);
        try
        {
            using var surface = Surface(path);
            surface.SetPlaying(true);
            var started = Environment.TickCount64;
            while (Environment.TickCount64 - started < 8000)
            {
                lock (_failures)
                {
                    if (_failures.Count > 0) break;
                }
                await Task.Delay(50, TestContext.Current.CancellationToken);
            }
            lock (_failures) Assert.Contains("PlaybackFailed", Assert.Single(_failures));
            Assert.Equal(0, _counters.Snapshot().FramesPresented);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public async Task A_webm_either_plays_or_says_why_it_cannot()
    {
        // Windows needs the VP9 Video Extensions for this, so both outcomes are legitimate. What
        // is not legitimate is hanging, or claiming to play with nothing on screen.
        var webm = Path.Combine(Path.GetDirectoryName(Fixture())!, "sample.webm");
        using var surface = Surface(webm);
        surface.SetPlaying(true);

        var started = Environment.TickCount64;
        while (Environment.TickCount64 - started < 6000 && _counters.Snapshot().FramesPresented < 10)
        {
            lock (_failures)
            {
                if (_failures.Count > 0) break;
            }
            await Task.Delay(50, TestContext.Current.CancellationToken);
        }

        var frames = _counters.Snapshot().FramesPresented;
        string? failure;
        lock (_failures) failure = _failures.FirstOrDefault();
        File.WriteAllText(Path.Combine(Path.GetTempPath(), "awall-webm-result.txt"), $"frames={frames} failure={failure}");
        Assert.True(frames >= 10 || failure is not null, "Neither frames nor a failure appeared.");
    }

    [Fact]
    public async Task A_missing_file_fails_and_reports_why()
    {
        using var surface = Surface(Path.Combine(Path.GetTempPath(), "awall-no-such-file.mp4"));
        surface.SetPlaying(true);
        var started = Environment.TickCount64;
        while (Environment.TickCount64 - started < 5000)
        {
            lock (_failures)
            {
                if (_failures.Count > 0) break;
            }
            await Task.Delay(50, TestContext.Current.CancellationToken);
        }
        lock (_failures) Assert.Contains("missing", Assert.Single(_failures));
    }
}
