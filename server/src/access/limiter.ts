/**
 * Failed sign-ins, in memory (a restart clears it). Three rules, checked before the password is:
 *
 * - Per IP: after `ipMax` failures within `windowMs` an address may not try other e-mails until the window moves on
 *   (made-up e-mails cannot dodge the per-pair limit, and each try costs a scrypt run).
 * - Per e-mail + IP, other e-mails: after `max` failures within `windowMs` the pair is blocked (429 + Retry-After).
 * - Per e-mail + IP, the configured admin e-mail ("soft"): after `max` failures each further try waits longer
 *   (2, 4, 8 … up to `maxDelaySec` seconds after the last failure) instead of a 15-minute block, so a wrong guess
 *   from a shared address (a proxy, an office NAT) slows the admin down but never locks them out.
 */
export class LoginLimiter {
  private failures = new Map<string, number[]>();

  constructor(
    readonly max = 5,
    readonly windowMs = 15 * 60_000,
    private now: () => number = Date.now,
    /** Upper bound on tracked keys, so a flood of made-up e-mails cannot grow the map without limit. */
    private maxKeys = 10_000,
    readonly ipMax = 20,
    readonly maxDelaySec = 60,
  ) {}

  private key(email: string, ip: string): string {
    return `${email.trim().toLowerCase()}\n${ip}`;
  }

  private ipKey(ip: string): string {
    return `ip\n${ip}`;
  }

  private recent(key: string): number[] {
    const cut = this.now() - this.windowMs;
    const list = (this.failures.get(key) ?? []).filter((t) => t > cut);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  private hardWait(list: number[], max: number): number {
    if (list.length < max) return 0;
    return Math.max(1, Math.ceil((list[list.length - max] + this.windowMs - this.now()) / 1000));
  }

  /**
   * Seconds until the next attempt is allowed, or 0 when it is allowed now. `soft`: the e-mail is the configured
   * admin's (progressive delay, and the per-IP rule does not apply to it).
   */
  retryAfter(email: string, ip: string, soft = false): number {
    const list = this.recent(this.key(email, ip));
    if (!soft) return Math.max(this.hardWait(this.recent(this.ipKey(ip)), this.ipMax), this.hardWait(list, this.max));
    if (list.length < this.max) return 0;
    const delay = Math.min(this.maxDelaySec, 2 ** (list.length - this.max + 1)) * 1000;
    const wait = list[list.length - 1] + delay - this.now();
    return wait > 0 ? Math.ceil(wait / 1000) : 0;
  }

  fail(email: string, ip: string): void {
    this.push(this.key(email, ip), this.max + 16);
    this.push(this.ipKey(ip), this.ipMax);
  }

  succeed(email: string, ip: string): void {
    this.failures.delete(this.key(email, ip));
  }

  private push(key: string, keep: number): void {
    const list = this.recent(key);
    list.push(this.now());
    if (!this.failures.has(key) && this.failures.size >= this.maxKeys) this.prune();
    this.failures.set(key, list.slice(-keep));
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
