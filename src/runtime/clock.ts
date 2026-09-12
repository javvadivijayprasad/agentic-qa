/** Time source for the loop. Injected so runs are reproducible in tests and fixtures. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/**
 * Deterministic clock: starts at `start` and advances `step` ms on every read.
 * Used by the fixture generator and golden tests.
 */
export class SteppingClock implements Clock {
  private t: number;
  constructor(
    start: number,
    private readonly step: number,
  ) {
    this.t = start - step;
  }
  now(): number {
    this.t += this.step;
    return this.t;
  }
  /** Advance without producing a reading (e.g. to model a long tool call). */
  advance(ms: number): void {
    this.t += ms;
  }
}
