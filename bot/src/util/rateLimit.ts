/** キーごとのスライディングウィンドウ方式の回数制限 (メモリ上) */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  /** limit が 0 なら無制限 */
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** 枠が残っていれば 1 回分消費して true、上限なら false */
  tryTake(key: string, now = Date.now()): boolean {
    if (this.limit === 0) return true;
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    const ok = recent.length < this.limit;
    if (ok) recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.sweep(now);
    return ok;
  }

  private sweep(now: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    }
  }
}
