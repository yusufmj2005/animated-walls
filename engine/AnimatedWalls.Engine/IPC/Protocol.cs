using System.Text.Json;
using System.Text.Json.Serialization;
using AnimatedWalls.Engine.Core;
using AnimatedWalls.Engine.Desktop;
using AnimatedWalls.Engine.Visibility;

namespace AnimatedWalls.Engine.IPC;

// Wire contract with Electron. The TypeScript side is
// packages/shared-types/src/engine.ts and must change together with this file.

public sealed record RpcRequest(long Id, string Method, JsonElement? Params);
public sealed record RpcError(int Code, string Message);
public sealed record RpcResponse(long Id, JsonElement? Result, RpcError? Error);
public sealed record RpcEvent(string Event, JsonElement Data);

public static class RpcErrorCodes
{
    public const int InvalidParams = -32602;
    public const int MethodNotFound = -32601;
    public const int InternalError = -32603;
    public const int Unauthenticated = -32001;
}

public sealed record HelloParams(string ClientNonce, int ProtocolVersion);
public sealed record HelloResult(string ServerNonce, string ServerProof, int ProtocolVersion, string EngineVersion);
public sealed record AuthenticateParams(string ClientProof);
public sealed record AuthenticateResult(bool Authenticated);

public sealed record SetAssignmentsParams(IReadOnlyList<DisplayAssignment> Assignments);
public sealed record SetPausedParams(bool Paused);
public sealed record SetLogLevelParams(string Level);
public sealed record SetLogLevelResult(string Level);
public sealed record ShutdownResult(bool Accepted);
public sealed record ReadyMessage(string Event, string Pipe, int Pid);

public sealed record DiagnoseReport(
    string EngineVersion,
    GpuCapabilities Gpu,
    IReadOnlyList<DisplayInfo> Displays,
    IReadOnlyList<DisplayVisibility> Visibility,
    IReadOnlyList<WindowSnapshotProvider.WindowDump> Windows,
    DesktopHostProbe DesktopHost);

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    // Nulls are written, because the TypeScript contract types these fields as "| null" and
    // an omitted field arrives as undefined, which passes a check like "!== null".
    PropertyNameCaseInsensitive = false)]
[JsonSerializable(typeof(RpcRequest))]
[JsonSerializable(typeof(RpcResponse))]
[JsonSerializable(typeof(RpcEvent))]
[JsonSerializable(typeof(HelloParams))]
[JsonSerializable(typeof(HelloResult))]
[JsonSerializable(typeof(AuthenticateParams))]
[JsonSerializable(typeof(AuthenticateResult))]
[JsonSerializable(typeof(SetAssignmentsParams))]
[JsonSerializable(typeof(SetPausedParams))]
[JsonSerializable(typeof(SetLogLevelParams))]
[JsonSerializable(typeof(SetLogLevelResult))]
[JsonSerializable(typeof(ShutdownResult))]
[JsonSerializable(typeof(ReadyMessage))]
[JsonSerializable(typeof(PlaybackConfig))]
[JsonSerializable(typeof(EngineHealth))]
[JsonSerializable(typeof(EngineState))]
[JsonSerializable(typeof(EngineDiagnostics))]
[JsonSerializable(typeof(GpuCapabilities))]
[JsonSerializable(typeof(DiagnoseReport))]
[JsonSerializable(typeof(HostingProofOfConcept.PocReport))]
public sealed partial class ProtocolJson : JsonSerializerContext;
