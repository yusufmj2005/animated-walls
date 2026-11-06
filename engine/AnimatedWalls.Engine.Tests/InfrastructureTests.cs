using System.Text;
using System.Text.Json;
using AnimatedWalls.Engine.Core;
using AnimatedWalls.Engine.Diagnostics;
using AnimatedWalls.Engine.IPC;
using Xunit;

namespace AnimatedWalls.Engine.Tests;

public class FrameCodecTests
{
    private static CancellationToken Token => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_frame_survives_a_round_trip()
    {
        using var stream = new MemoryStream();
        var payload = Encoding.UTF8.GetBytes("""{"hello":"wörld"}""");
        await FrameCodec.WriteFrameAsync(stream, payload, Token);
        stream.Position = 0;
        Assert.Equal(payload, await FrameCodec.ReadFrameAsync(stream, Token));
    }

    [Fact]
    public async Task A_clean_end_of_stream_returns_null()
    {
        using var stream = new MemoryStream();
        Assert.Null(await FrameCodec.ReadFrameAsync(stream, Token));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(FrameCodec.MaxFrameBytes + 1)]
    public async Task An_invalid_length_is_rejected_before_allocating(int length)
    {
        using var stream = new MemoryStream(BitConverter.GetBytes(length));
        await Assert.ThrowsAsync<FrameCodec.ProtocolException>(() => FrameCodec.ReadFrameAsync(stream, Token));
    }

    [Fact]
    public async Task A_truncated_frame_is_rejected()
    {
        using var stream = new MemoryStream([10, 0, 0, 0, 1, 2]);
        await Assert.ThrowsAsync<FrameCodec.ProtocolException>(() => FrameCodec.ReadFrameAsync(stream, Token));
    }

    [Fact]
    public async Task A_truncated_header_is_rejected()
    {
        using var stream = new MemoryStream([10, 0]);
        await Assert.ThrowsAsync<FrameCodec.ProtocolException>(() => FrameCodec.ReadFrameAsync(stream, Token));
    }

    [Fact]
    public async Task An_oversized_frame_is_not_sent()
    {
        using var stream = new MemoryStream();
        await Assert.ThrowsAsync<FrameCodec.ProtocolException>(() => FrameCodec.WriteFrameAsync(stream, new byte[FrameCodec.MaxFrameBytes + 1], Token));
    }
}

public class SessionAuthenticatorTests
{
    private static readonly byte[] Token = Encoding.UTF8.GetBytes("shared-token");

    [Fact]
    public void Both_sides_derive_the_same_proof()
    {
        var authenticator = new SessionAuthenticator(Token);
        Assert.Equal(new SessionAuthenticator(Token).ServerProof("nonce"), authenticator.ServerProof("nonce"));
    }

    [Fact]
    public void A_different_token_gives_a_different_proof() =>
        Assert.NotEqual(new SessionAuthenticator(Token).ServerProof("nonce"), new SessionAuthenticator([1, 2, 3]).ServerProof("nonce"));

    [Fact]
    public void A_server_proof_cannot_be_replayed_as_a_client_proof()
    {
        var authenticator = new SessionAuthenticator(Token);
        var serverProof = authenticator.ServerProof("nonce");
        Assert.False(authenticator.VerifyClientProof("nonce", serverProof));
    }

    [Fact]
    public void A_wrong_client_proof_is_rejected() =>
        Assert.False(new SessionAuthenticator(Token).VerifyClientProof("nonce", "wrong"));

    [Fact]
    public void Nonces_do_not_repeat() =>
        Assert.NotEqual(SessionAuthenticator.CreateNonce(), SessionAuthenticator.CreateNonce());
}

public class RpcDispatcherTests
{
    [Fact]
    public void Unknown_methods_are_rejected()
    {
        var fault = Assert.Throws<RpcDispatcher.RpcFault>(() => new RpcDispatcher().Invoke("nope", null));
        Assert.Equal(RpcErrorCodes.MethodNotFound, fault.Code);
    }

    [Fact]
    public void Missing_parameters_are_rejected()
    {
        var dispatcher = new RpcDispatcher();
        dispatcher.Register("x", ProtocolJson.Default.SetPausedParams, ProtocolJson.Default.ShutdownResult, _ => new ShutdownResult(true));
        var fault = Assert.Throws<RpcDispatcher.RpcFault>(() => dispatcher.Invoke("x", null));
        Assert.Equal(RpcErrorCodes.InvalidParams, fault.Code);
    }

    [Fact]
    public void Wrongly_typed_parameters_are_rejected()
    {
        var dispatcher = new RpcDispatcher();
        dispatcher.Register("x", ProtocolJson.Default.SetPausedParams, ProtocolJson.Default.ShutdownResult, _ => new ShutdownResult(true));
        using var document = JsonDocument.Parse("""{"paused":"yes"}""");
        var fault = Assert.Throws<RpcDispatcher.RpcFault>(() => dispatcher.Invoke("x", document.RootElement));
        Assert.Equal(RpcErrorCodes.InvalidParams, fault.Code);
    }

    [Fact]
    public void Results_use_camel_case_as_the_contract_requires()
    {
        var dispatcher = new RpcDispatcher();
        dispatcher.Register("x", ProtocolJson.Default.ShutdownResult, () => new ShutdownResult(true));
        Assert.True(dispatcher.Invoke("x", null).GetProperty("accepted").GetBoolean());
    }
}

public sealed class StructuredLoggerTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "awall-log-tests-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_directory)) Directory.Delete(_directory, recursive: true);
    }

    [Fact]
    public void Each_line_is_parsable_json_with_the_expected_fields()
    {
        using (var logger = new StructuredLogger(_directory))
        {
            logger.Info("test.source", "test.event", new Dictionary<string, object?> { ["answer"] = 42, ["list"] = new[] { "a" } });
        }
        var line = File.ReadAllLines(Path.Combine(_directory, "engine.log")).Single();
        using var document = JsonDocument.Parse(line);
        Assert.Equal("info", document.RootElement.GetProperty("level").GetString());
        Assert.Equal("test.event", document.RootElement.GetProperty("event").GetString());
        Assert.Equal(42, document.RootElement.GetProperty("data").GetProperty("answer").GetInt32());
    }

    [Fact]
    public void Lines_below_the_level_are_dropped()
    {
        using (var logger = new StructuredLogger(_directory, level: LogLevel.Warn))
        {
            logger.Info("s", "dropped");
            logger.Warn("s", "kept");
        }
        Assert.Contains("kept", File.ReadAllText(Path.Combine(_directory, "engine.log")));
        Assert.DoesNotContain("dropped", File.ReadAllText(Path.Combine(_directory, "engine.log")));
    }

    [Fact]
    public void Rotation_keeps_a_bounded_number_of_files()
    {
        using (var logger = new StructuredLogger(_directory, maxFileBytes: 512, maxFiles: 3))
        {
            for (var index = 0; index < 200; index++) logger.Info("s", "event", new Dictionary<string, object?> { ["index"] = index });
        }

        var files = Directory.GetFiles(_directory).Select(Path.GetFileName).Order(StringComparer.Ordinal).ToArray();
        Assert.Equal(["engine.log", "engine.log.1", "engine.log.2"], files);
        foreach (var file in Directory.GetFiles(_directory))
        {
            Assert.True(new FileInfo(file).Length <= 512);
        }
        Assert.Contains("\"index\":199", File.ReadAllText(Path.Combine(_directory, "engine.log")));
    }

    [Fact]
    public void Nothing_is_written_after_disposal()
    {
        var logger = new StructuredLogger(_directory);
        logger.Info("s", "before");
        logger.Dispose();
        logger.Info("s", "after");
        var text = File.ReadAllText(Path.Combine(_directory, "engine.log"));
        Assert.Contains("before", text);
        Assert.DoesNotContain("after", text);
    }

    [Fact]
    public void An_unwritable_directory_does_not_throw()
    {
        var blocked = Path.Combine(_directory, "file-not-dir");
        Directory.CreateDirectory(_directory);
        File.WriteAllText(blocked, "x");
        using var logger = new StructuredLogger(Path.Combine(blocked, "logs"));
        logger.Info("s", "event");
    }

    [Theory]
    [InlineData("debug", LogLevel.Debug)]
    [InlineData("WARN", LogLevel.Warn)]
    public void Level_names_parse(string text, LogLevel expected)
    {
        Assert.True(StructuredLogger.TryParseLevel(text, out var level));
        Assert.Equal(expected, level);
    }

    [Fact]
    public void An_unknown_level_is_reported() => Assert.False(StructuredLogger.TryParseLevel("loud", out _));
}

public class ModelsTests
{
    [Fact]
    public void Rect_intersection_is_correct()
    {
        Assert.Equal(new Rect(5, 5, 5, 5), new Rect(0, 0, 10, 10).Intersect(new Rect(5, 5, 10, 10)));
        Assert.True(new Rect(0, 0, 10, 10).Intersect(new Rect(10, 0, 10, 10)).IsEmpty);
    }

    [Fact]
    public void Empty_values_are_sent_as_null_as_the_contract_says()
    {
        var state = new DisplayRenderState("d", RenderDecisions.Idle, RenderReasons.NoWallpaperAssigned, null, "now");
        var json = JsonSerializer.Serialize(new EngineState([], [], new SessionState(false, "on", false, false, false), [state], false), ProtocolJson.Default.EngineState);
        Assert.Contains("\"wallpaperId\":null", json);
        Assert.Contains("\"sessionDisconnected\":false", json);
        Assert.Contains("\"screenSaverRunning\":false", json);
    }

    [Fact]
    public void Rect_serialises_with_contract_names()
    {
        var json = JsonSerializer.Serialize(new DisplayVisibility("d", "visible", 1, [new Rect(1, 2, 3, 4)], null), ProtocolJson.Default.EngineState.Options);
        Assert.Contains("\"visibleRects\":[{\"x\":1,\"y\":2,\"width\":3,\"height\":4}]", json);
    }
}
