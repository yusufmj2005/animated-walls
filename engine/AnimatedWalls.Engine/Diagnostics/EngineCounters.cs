using AnimatedWalls.Engine.Core;

namespace AnimatedWalls.Engine.Diagnostics;

/// <summary>
/// Monotonic counters behind the suspended-rendering guarantee. A test can sample
/// them twice and prove that nothing was evaluated, presented or decoded in between,
/// which GPU percentages alone cannot show.
/// </summary>
public sealed class EngineCounters
{
    private long _winEvents;
    private long _evaluations;
    private long _transitions;
    private long _framesPresented;
    private long _framesDecoded;

    public void WinEventReceived() => Interlocked.Increment(ref _winEvents);
    public void VisibilityEvaluated() => Interlocked.Increment(ref _evaluations);
    public void RenderTransition() => Interlocked.Increment(ref _transitions);
    public void FramePresented() => Interlocked.Increment(ref _framesPresented);
    public void FrameDecoded() => Interlocked.Increment(ref _framesDecoded);

    public EngineCounterValues Snapshot() => new(
        Interlocked.Read(ref _winEvents),
        Interlocked.Read(ref _evaluations),
        Interlocked.Read(ref _transitions),
        Interlocked.Read(ref _framesPresented),
        Interlocked.Read(ref _framesDecoded));
}
