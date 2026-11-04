using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AnimatedWalls.Engine.Diagnostics;

public enum LogLevel
{
    Debug = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
}

/// <summary>
/// Writes one JSON object per line so logs can be read and queried by machine.
/// A logging failure must never take the engine down, but it must not vanish
/// either, so the first failure is reported on stderr, which the supervisor records.
/// </summary>
public sealed class StructuredLogger : IDisposable
{
    public const long DefaultMaxFileBytes = 5 * 1024 * 1024;
    public const int DefaultMaxFiles = 5;

    private static readonly JsonSerializerOptions WriteOptions = new() { WriteIndented = false };

    private readonly object _gate = new();
    private readonly long _maxFileBytes;
    private readonly int _maxFiles;
    private FileStream? _stream;
    private bool _reportedFailure;
    private volatile LogLevel _level;

    public string? FilePath { get; }

    public LogLevel Level
    {
        get => _level;
        set => _level = value;
    }

    /// <summary>Creates a logger. A null directory keeps logging to stderr only.</summary>
    public StructuredLogger(string? directory, string fileName = "engine.log", LogLevel level = LogLevel.Info, long maxFileBytes = DefaultMaxFileBytes, int maxFiles = DefaultMaxFiles)
    {
        _level = level;
        _maxFileBytes = maxFileBytes;
        _maxFiles = maxFiles;
        if (directory is null) return;

        FilePath = Path.Combine(directory, fileName);
        try
        {
            Directory.CreateDirectory(directory);
            _stream = OpenStream(FilePath);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            ReportFailure("open", exception);
        }
    }

    public static bool TryParseLevel(string? text, out LogLevel level)
    {
        switch (text?.ToLowerInvariant())
        {
            case "debug": level = LogLevel.Debug; return true;
            case "info": level = LogLevel.Info; return true;
            case "warn": level = LogLevel.Warn; return true;
            case "error": level = LogLevel.Error; return true;
            default: level = LogLevel.Info; return false;
        }
    }

    public void Debug(string source, string eventName, object? data = null) => Write(LogLevel.Debug, source, eventName, data);
    public void Info(string source, string eventName, object? data = null) => Write(LogLevel.Info, source, eventName, data);
    public void Warn(string source, string eventName, object? data = null) => Write(LogLevel.Warn, source, eventName, data);
    public void Error(string source, string eventName, object? data = null) => Write(LogLevel.Error, source, eventName, data);

    public void Error(string source, string eventName, Exception exception) =>
        Write(LogLevel.Error, source, eventName, new Dictionary<string, object?>
        {
            ["type"] = exception.GetType().FullName,
            ["message"] = exception.Message,
            ["stack"] = exception.StackTrace,
        });

    private void Write(LogLevel level, string source, string eventName, object? data)
    {
        if (level < _level) return;

        var line = Format(level, source, eventName, data);
        var bytes = Encoding.UTF8.GetBytes(line + "\n");

        lock (_gate)
        {
            if (_stream is null)
            {
                if (FilePath is null) Console.Error.WriteLine(line);
                return;
            }

            try
            {
                RotateIfNeeded(bytes.Length);
                _stream?.Write(bytes);
                _stream?.Flush();
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ObjectDisposedException)
            {
                ReportFailure("write", exception);
            }
        }
    }

    internal static string Format(LogLevel level, string source, string eventName, object? data)
    {
        var entry = new JsonObject
        {
            ["ts"] = DateTimeOffset.UtcNow.ToString("O"),
            ["level"] = level.ToString().ToLowerInvariant(),
            ["source"] = source,
            ["event"] = eventName,
        };
        if (data is not null) entry["data"] = ToNode(data);
        return entry.ToJsonString(WriteOptions);
    }

    /// <summary>Converts log data without reflection so the logger stays trim-safe.</summary>
    private static JsonNode? ToNode(object? value) => value switch
    {
        null => null,
        JsonNode node => node.DeepClone(),
        string text => JsonValue.Create(text),
        bool flag => JsonValue.Create(flag),
        int number => JsonValue.Create(number),
        long number => JsonValue.Create(number),
        double number => JsonValue.Create(double.IsFinite(number) ? number : 0),
        IDictionary<string, object?> map => new JsonObject(map.Select(pair => KeyValuePair.Create(pair.Key, ToNode(pair.Value)))),
        IEnumerable<string> items => new JsonArray(items.Select(item => (JsonNode?)JsonValue.Create(item)).ToArray()),
        _ => JsonValue.Create(value.ToString()),
    };

    private void RotateIfNeeded(int incomingBytes)
    {
        if (_stream is null || FilePath is null || _stream.Length + incomingBytes <= _maxFileBytes) return;

        _stream.Dispose();
        _stream = null;
        try
        {
            File.Delete($"{FilePath}.{_maxFiles - 1}");
            for (var index = _maxFiles - 2; index >= 1; index--)
            {
                var from = $"{FilePath}.{index}";
                if (File.Exists(from)) File.Move(from, $"{FilePath}.{index + 1}");
            }
            File.Move(FilePath, $"{FilePath}.1");
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // Antivirus or a log viewer can hold a file open. Carrying on with an
            // oversized file beats losing log lines, and rotation retries next write.
            ReportFailure("rotate", exception);
        }
        _stream = OpenStream(FilePath);
    }

    private static FileStream OpenStream(string path) =>
        new(path, FileMode.Append, FileAccess.Write, FileShare.Read | FileShare.Delete);

    private void ReportFailure(string operation, Exception exception)
    {
        if (_reportedFailure) return;
        _reportedFailure = true;
        Console.Error.WriteLine($"[logger] {operation} failed: {exception.GetType().Name}: {exception.Message}");
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _stream?.Dispose();
            _stream = null;
        }
    }
}
