namespace AnimatedWalls.Engine.Core;

public static class EngineInfo
{
    public const string Version = "0.1.0";

    /// <summary>Must match ENGINE_PROTOCOL_VERSION in packages/shared-types/src/engine.ts.</summary>
    public const int ProtocolVersion = 1;

    /// <summary>Reported to the UI, so a render decision is shown as frames really being drawn.</summary>
    public const bool RendererImplemented = true;
}
