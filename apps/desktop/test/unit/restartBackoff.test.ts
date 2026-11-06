import { describe, expect, it } from 'vitest';
import { RestartBackoff } from '../../electron/main/engine/restartBackoff';

describe('RestartBackoff', () => {
  function create() {
    const clock = { now: 1_000_000 };
    return { clock, backoff: new RestartBackoff([1, 2, 3], 100, () => clock.now) };
  }

  it('steps through the delays and then gives up', () => {
    const { backoff } = create();
    expect([backoff.next(), backoff.next(), backoff.next(), backoff.next()]).toEqual([1, 2, 3, undefined]);
  });

  it('keeps climbing when the engine crashes soon after connecting', () => {
    const { backoff, clock } = create();
    backoff.next();
    backoff.markConnected();
    clock.now += 50;
    expect(backoff.next()).toBe(2);
  });

  it('starts over after a stable run', () => {
    const { backoff, clock } = create();
    backoff.next();
    backoff.next();
    backoff.markConnected();
    clock.now += 500;
    expect(backoff.next()).toBe(1);
  });

  it('gives up on an engine that fails at launch, however long ago it last connected', () => {
    const { backoff, clock } = create();
    backoff.markConnected();
    clock.now += 500;
    // The engine was stable once and now fails every launch, without ever connecting again.
    const delays = [backoff.next(), backoff.next(), backoff.next(), backoff.next()];
    expect(delays).toEqual([1, 2, 3, undefined]);
  });

  it('starts over when reset by hand', () => {
    const { backoff } = create();
    backoff.next();
    backoff.next();
    backoff.reset();
    expect(backoff.next()).toBe(1);
  });
});
