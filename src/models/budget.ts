/**
 * A spending cap for model calls made several at a time. A call's cost is only known once it
 * returns, so each call in flight is assumed to cost as much as the dearest call seen so far ($0.50
 * before any has returned). Overshoot is bounded by the calls running at once.
 */
export class Budget {
  private spent = 0;
  private inFlight = 0;
  private estimate = 0.5;
  private seenCost = false;
  private waiting: (() => void)[] = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  /**
   * Waits until another call fits under the limit, then counts it as in flight. While calls are in
   * flight a new one waits for them rather than being given up on an estimate. False once the limit
   * is reached by money actually spent.
   */
  async start(): Promise<boolean> {
    while (this.inFlight > 0 && this.spent + this.inFlight * this.estimate >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    if (this.spent >= this.limit) return false;
    this.inFlight++;
    return true;
  }

  /** Awaits a call begun after start() returned true, and counts what it cost. */
  async track<T extends { cost: number }>(call: Promise<T>): Promise<T> {
    let cost: number | undefined;
    try {
      const result = await call;
      cost = result.cost;
      return result;
    } finally {
      this.finish(cost);
    }
  }

  private finish(cost: number | undefined): void {
    this.inFlight--;
    if (cost !== undefined) {
      this.spent += cost;
      this.estimate = this.seenCost ? Math.max(this.estimate, cost) : cost;
      this.seenCost = true;
    }
    for (const wake of this.waiting.splice(0)) wake();
  }
}
