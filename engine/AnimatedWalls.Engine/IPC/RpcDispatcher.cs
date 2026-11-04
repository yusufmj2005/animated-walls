using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

namespace AnimatedWalls.Engine.IPC;

/// <summary>A closed table of methods the client may call. Anything else is rejected.</summary>
public sealed class RpcDispatcher
{
    public sealed class RpcFault(int code, string message) : Exception(message)
    {
        public int Code { get; } = code;
    }

    private readonly Dictionary<string, Func<JsonElement?, JsonElement>> _methods = new(StringComparer.Ordinal);

    public void Register<TResult>(string method, JsonTypeInfo<TResult> resultType, Func<TResult> handler)
    {
        _methods[method] = _ => JsonSerializer.SerializeToElement(handler(), resultType);
    }

    public void Register<TParams, TResult>(string method, JsonTypeInfo<TParams> paramsType, JsonTypeInfo<TResult> resultType, Func<TParams, TResult> handler)
    {
        _methods[method] = rawParams => JsonSerializer.SerializeToElement(handler(ReadParams(method, rawParams, paramsType)), resultType);
    }

    public JsonElement Invoke(string method, JsonElement? rawParams)
    {
        if (!_methods.TryGetValue(method, out var handler))
        {
            throw new RpcFault(RpcErrorCodes.MethodNotFound, $"Unknown method '{method}'.");
        }
        return handler(rawParams);
    }

    private static TParams ReadParams<TParams>(string method, JsonElement? rawParams, JsonTypeInfo<TParams> type)
    {
        if (rawParams is not { ValueKind: JsonValueKind.Object } element)
        {
            throw new RpcFault(RpcErrorCodes.InvalidParams, $"'{method}' needs an object of parameters.");
        }
        try
        {
            return element.Deserialize(type) ?? throw new RpcFault(RpcErrorCodes.InvalidParams, $"'{method}' received empty parameters.");
        }
        catch (JsonException exception)
        {
            throw new RpcFault(RpcErrorCodes.InvalidParams, $"'{method}' received invalid parameters: {exception.Message}");
        }
    }
}
