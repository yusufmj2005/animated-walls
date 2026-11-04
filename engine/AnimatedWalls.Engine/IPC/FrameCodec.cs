using System.Buffers.Binary;

namespace AnimatedWalls.Engine.IPC;

/// <summary>
/// Length-prefixed frames: a 4-byte little-endian size followed by UTF-8 JSON. The size
/// is checked before any allocation, so a bad header cannot force a huge buffer.
/// </summary>
public static class FrameCodec
{
    public const int MaxFrameBytes = 1024 * 1024;

    public sealed class ProtocolException(string message) : Exception(message);

    /// <summary>Reads one frame, or returns null on a clean end of stream.</summary>
    public static async Task<byte[]?> ReadFrameAsync(Stream stream, CancellationToken cancellationToken)
    {
        var header = new byte[4];
        var headerRead = await ReadFullyAsync(stream, header, cancellationToken).ConfigureAwait(false);
        if (headerRead == 0) return null;
        if (headerRead < header.Length) throw new ProtocolException("The stream ended inside a frame header.");

        var length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length is <= 0 or > MaxFrameBytes) throw new ProtocolException($"Invalid frame length {length}.");

        var payload = new byte[length];
        var payloadRead = await ReadFullyAsync(stream, payload, cancellationToken).ConfigureAwait(false);
        if (payloadRead < length) throw new ProtocolException("The stream ended inside a frame.");
        return payload;
    }

    public static async Task WriteFrameAsync(Stream stream, byte[] payload, CancellationToken cancellationToken)
    {
        if (payload.Length > MaxFrameBytes) throw new ProtocolException($"Refusing to send a {payload.Length}-byte frame.");

        // One write per frame, so a frame is never interleaved at the pipe level.
        var buffer = new byte[payload.Length + 4];
        BinaryPrimitives.WriteInt32LittleEndian(buffer, payload.Length);
        payload.CopyTo(buffer, 4);
        await stream.WriteAsync(buffer, cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    private static async Task<int> ReadFullyAsync(Stream stream, byte[] buffer, CancellationToken cancellationToken)
    {
        var total = 0;
        while (total < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(total), cancellationToken).ConfigureAwait(false);
            if (read == 0) return total;
            total += read;
        }
        return total;
    }
}
