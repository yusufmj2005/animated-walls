using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using AnimatedWalls.Engine.Core;
using AnimatedWalls.Engine.Diagnostics;

namespace AnimatedWalls.Engine.IPC;

/// <summary>
/// Local RPC endpoint for one client. Access is layered:
///   1. The pipe name is random per launch.
///   2. FirstPipeInstance fails startup if the name is already taken.
///   3. The ACL allows only the current user and denies network logons.
///   4. A client must complete the mutual HMAC handshake before any method runs.
/// </summary>
public sealed class PipeServer(
    string pipeName,
    SessionAuthenticator authenticator,
    RpcDispatcher dispatcher,
    StructuredLogger logger) : IDisposable
{
    private const string LogSource = "engine.ipc";
    private static readonly TimeSpan HandshakeTimeout = TimeSpan.FromSeconds(5);

    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private NamedPipeServerStream? _pipe;
    private volatile bool _authenticated;

    /// <summary>Raised when an authenticated client disconnects.</summary>
    public event Action? ClientDisconnected;

    public void Listen()
    {
        var security = new PipeSecurity();
        var currentUser = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("Could not read the current user's SID.");
        security.AddAccessRule(new PipeAccessRule(currentUser, PipeAccessRights.ReadWrite | PipeAccessRights.CreateNewInstance, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));

        // One instance for the engine's whole life, so the name is never free to squat.
        _pipe = NamedPipeServerStreamAcl.Create(
            pipeName,
            PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.FirstPipeInstance,
            FrameCodec.MaxFrameBytes,
            FrameCodec.MaxFrameBytes,
            security);
    }

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        var pipe = _pipe ?? throw new InvalidOperationException("Listen must be called first.");

        while (!cancellationToken.IsCancellationRequested)
        {
            await pipe.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);
            logger.Info(LogSource, "client.connected");

            var wasAuthenticated = false;
            try
            {
                wasAuthenticated = await ServeClientAsync(pipe, cancellationToken).ConfigureAwait(false);
            }
            catch (FrameCodec.ProtocolException exception)
            {
                logger.Warn(LogSource, "client.protocol-error", new Dictionary<string, object?> { ["message"] = exception.Message });
            }
            catch (JsonException exception)
            {
                logger.Warn(LogSource, "client.invalid-json", new Dictionary<string, object?> { ["message"] = exception.Message });
            }
            catch (IOException exception)
            {
                logger.Info(LogSource, "client.connection-lost", new Dictionary<string, object?> { ["message"] = exception.Message });
                wasAuthenticated = _authenticated;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }

            _authenticated = false;
            if (pipe.IsConnected) pipe.Disconnect();
            logger.Info(LogSource, "client.disconnected");

            if (wasAuthenticated)
            {
                ClientDisconnected?.Invoke();
            }
        }
    }

    /// <summary>Sends an event. Dropped when there is no authenticated client to receive it.</summary>
    public async Task SendEventAsync<T>(string eventName, T data, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> type, CancellationToken cancellationToken)
    {
        if (!_authenticated || _pipe is not { IsConnected: true }) return;
        var message = new RpcEvent(eventName, JsonSerializer.SerializeToElement(data, type));
        await WriteAsync(JsonSerializer.SerializeToUtf8Bytes(message, ProtocolJson.Default.RpcEvent), cancellationToken).ConfigureAwait(false);
    }

    private async Task<bool> ServeClientAsync(NamedPipeServerStream pipe, CancellationToken cancellationToken)
    {
        if (!await AuthenticateAsync(pipe, cancellationToken).ConfigureAwait(false)) return false;

        _authenticated = true;
        logger.Info(LogSource, "client.authenticated");

        while (!cancellationToken.IsCancellationRequested)
        {
            var frame = await FrameCodec.ReadFrameAsync(pipe, cancellationToken).ConfigureAwait(false);
            if (frame is null) return true;

            var request = JsonSerializer.Deserialize(frame, ProtocolJson.Default.RpcRequest)
                ?? throw new FrameCodec.ProtocolException("The request was empty.");

            // Handlers run off the read loop so a slow one, like the GPU usage sampler,
            // cannot stall health checks and make a healthy engine look hung.
            _ = Task.Run(() => HandleRequestAsync(request, cancellationToken), cancellationToken);
        }
        return true;
    }

    private async Task HandleRequestAsync(RpcRequest request, CancellationToken cancellationToken)
    {
        RpcResponse response;
        try
        {
            response = new RpcResponse(request.Id, dispatcher.Invoke(request.Method, request.Params), null);
        }
        catch (RpcDispatcher.RpcFault fault)
        {
            logger.Warn(LogSource, "rpc.rejected", new Dictionary<string, object?> { ["method"] = request.Method, ["message"] = fault.Message });
            response = new RpcResponse(request.Id, null, new RpcError(fault.Code, fault.Message));
        }
        catch (Exception exception)
        {
            logger.Error(LogSource, "rpc.failed", exception);
            response = new RpcResponse(request.Id, null, new RpcError(RpcErrorCodes.InternalError, $"'{request.Method}' failed: {exception.Message}"));
        }

        try
        {
            await WriteAsync(JsonSerializer.SerializeToUtf8Bytes(response, ProtocolJson.Default.RpcResponse), cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is IOException or ObjectDisposedException or InvalidOperationException)
        {
            logger.Warn(LogSource, "rpc.response-undeliverable", new Dictionary<string, object?> { ["method"] = request.Method, ["message"] = exception.Message });
        }
    }

    private async Task<bool> AuthenticateAsync(NamedPipeServerStream pipe, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(HandshakeTimeout);

        try
        {
            var helloFrame = await FrameCodec.ReadFrameAsync(pipe, timeout.Token).ConfigureAwait(false);
            if (helloFrame is null) return false;

            var helloRequest = JsonSerializer.Deserialize(helloFrame, ProtocolJson.Default.RpcRequest);
            if (helloRequest?.Method != "session.hello" || helloRequest.Params is not { } helloParams) return Reject("the first message was not session.hello");

            var hello = helloParams.Deserialize(ProtocolJson.Default.HelloParams);
            if (hello is null || string.IsNullOrEmpty(hello.ClientNonce)) return Reject("session.hello had no nonce");
            if (hello.ProtocolVersion != EngineInfo.ProtocolVersion)
            {
                await SendResponseAsync(helloRequest.Id, null, new RpcError(RpcErrorCodes.InvalidParams, $"Protocol {EngineInfo.ProtocolVersion} is required, the client uses {hello.ProtocolVersion}."), timeout.Token).ConfigureAwait(false);
                return Reject("protocol version mismatch");
            }

            var serverNonce = SessionAuthenticator.CreateNonce();
            var helloResult = new HelloResult(serverNonce, authenticator.ServerProof(hello.ClientNonce), EngineInfo.ProtocolVersion, EngineInfo.Version);
            await SendResponseAsync(helloRequest.Id, JsonSerializer.SerializeToElement(helloResult, ProtocolJson.Default.HelloResult), null, timeout.Token).ConfigureAwait(false);

            var authFrame = await FrameCodec.ReadFrameAsync(pipe, timeout.Token).ConfigureAwait(false);
            if (authFrame is null) return false;

            var authRequest = JsonSerializer.Deserialize(authFrame, ProtocolJson.Default.RpcRequest);
            if (authRequest?.Method != "session.authenticate" || authRequest.Params is not { } authParams) return Reject("the second message was not session.authenticate");

            var auth = authParams.Deserialize(ProtocolJson.Default.AuthenticateParams);
            if (auth is null || !authenticator.VerifyClientProof(serverNonce, auth.ClientProof))
            {
                await SendResponseAsync(authRequest.Id, null, new RpcError(RpcErrorCodes.Unauthenticated, "Authentication failed."), timeout.Token).ConfigureAwait(false);
                return Reject("the client proof was wrong");
            }

            await SendResponseAsync(authRequest.Id, JsonSerializer.SerializeToElement(new AuthenticateResult(true), ProtocolJson.Default.AuthenticateResult), null, timeout.Token).ConfigureAwait(false);
            return true;
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            return Reject("the handshake timed out");
        }
    }

    private bool Reject(string reason)
    {
        logger.Warn(LogSource, "client.rejected", new Dictionary<string, object?> { ["reason"] = reason });
        return false;
    }

    private Task SendResponseAsync(long id, JsonElement? result, RpcError? error, CancellationToken cancellationToken) =>
        WriteAsync(JsonSerializer.SerializeToUtf8Bytes(new RpcResponse(id, result, error), ProtocolJson.Default.RpcResponse), cancellationToken);

    private async Task WriteAsync(byte[] payload, CancellationToken cancellationToken)
    {
        var pipe = _pipe ?? throw new InvalidOperationException("The pipe is not listening.");
        await _writeLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await FrameCodec.WriteFrameAsync(pipe, payload, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    public void Dispose()
    {
        _pipe?.Dispose();
        _writeLock.Dispose();
    }
}
