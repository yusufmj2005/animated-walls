/**
 * Decides how long to wait before restarting a failed engine, and when to give up.
 * A connection that stayed up long enough earns a fresh start, but it counts only once:
 * otherwise an engine that now fails at launch would restart at the first step forever.
 */
export class RestartBackoff {
  private attempts = 0;
  private connectedAt = 0;

  constructor(
    private readonly delaysMs: readonly number[],
    private readonly stableAfterMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get attemptCount(): number {
    return this.attempts;
  }

  markConnected(): void {
    this.connectedAt = this.now();
  }

  reset(): void {
    this.attempts = 0;
    this.connectedAt = 0;
  }

  /** The delay before the next restart, or undefined to give up. */
  next(): number | undefined {
    if (this.connectedAt > 0 && this.now() - this.connectedAt > this.stableAfterMs) this.attempts = 0;
    this.connectedAt = 0;

    const delay = this.delaysMs[this.attempts];
    if (delay !== undefined) this.attempts += 1;
    return delay;
  }
}
