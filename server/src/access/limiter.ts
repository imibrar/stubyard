/**
 * Failed sign-ins per e-mail + IP: after `max` failures within `windowMs` the pair is blocked until the oldest
 * failure leaves the window (POST /api/auth/login answers 429 with Retry-After). In memory: a restart clears it.
 */
export class LoginLimiter {
  private failures = new Map<string, number[]>();

  constructor(
    readonly max = 5,
    readonly windowMs = 15 * 60_000,
    private now: () => number = Date.now,
    /** Upper bound on tracked pairs, so a flood of made-up e-mails cannot grow the map without limit. */
    private maxKeys = 10_000,
  ) {}

  private key(email: string, ip: string): string {
    return `${email.trim().toLowerCase()}\n${ip}`;
  }

  private recent(key: string): number[] {
    const cut = this.now() - this.windowMs;
    const list = (this.failures.get(key) ?? []).filter((t) => t > cut);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  /** Seconds until the next attempt is allowed, or 0 when it is allowed now. */
  retryAfter(email: string, ip: string): number {
    const list = this.recent(this.key(email, ip));
    if (list.length < this.max) return 0;
    return Math.max(1, Math.ceil((list[list.length - this.max] + this.windowMs - this.now()) / 1000));
  }

  fail(email: string, ip: string): void {
    const key = this.key(email, ip);
    const list = this.recent(key);
    list.push(this.now());
    if (!this.failures.has(key) && this.failures.size >= this.maxKeys) this.prune();
    this.failures.set(key, list.slice(-this.max));
  }

  succeed(email: string, ip: string): void {
    this.failures.delete(this.key(email, ip));
  }

  private prune(): void {
    for (const k of [...this.failures.keys()]) this.recent(k);
    // Still full: drop the oldest entries (Map keeps insertion order).
    for (const k of this.failures.keys()) {
      if (this.failures.size < this.maxKeys) break;
      this.failures.delete(k);
    }
  }
}
