export class RpcCounter {
  private events: number[] = [];

  /** Record one RPC call at now(). */
  incr(): void {
    const now = Date.now();
    this.events.push(now);
    this.gc(now);
  }

  /** Calls per minute over the last 60 seconds. */
  callsPerMin(): number {
    this.gc(Date.now());
    return this.events.length;
  }

  private gc(now: number): void {
    const cutoff = now - 60_000;
    let i = 0;
    while (i < this.events.length && this.events[i]! < cutoff) i++;
    if (i > 0) this.events = this.events.slice(i);
  }
}
