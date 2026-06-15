// ============================================================================
// Fixed-window rate limiter over Upstash Redis (REST).
// Protects /track against abuse/enumeration and avoids IP bans at the provider.
// ============================================================================

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  limit: number
}

export class RateLimiter {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly limit = 30, // requests
    private readonly windowSec = 60, // per minute
  ) {}

  /**
   * Counts the request from `identifier` (typically the IP) in the current window.
   * If the backend fails, it "fails open" (allows) so as not to bring down the service,
   * but logs it.
   */
  async check(identifier: string): Promise<RateLimitResult> {
    const window = Math.floor(this.nowSec() / this.windowSec)
    const key = `rl:track:${identifier}:${window}`

    try {
      const count = await this.incr(key)
      // On the first hit of the window, set the expiration.
      if (count === 1) await this.expire(key, this.windowSec)
      return {
        allowed: count <= this.limit,
        remaining: Math.max(0, this.limit - count),
        limit: this.limit,
      }
    } catch (e) {
      console.error('[ratelimit] backend error, fail-open:', (e as Error).message)
      return { allowed: true, remaining: this.limit, limit: this.limit }
    }
  }

  private nowSec(): number {
    return Math.floor(Date.now() / 1000)
  }

  private async incr(key: string): Promise<number> {
    const res = await fetch(`${this.url}/incr/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
    })
    if (!res.ok) throw new Error(`incr → ${res.status}`)
    const { result } = (await res.json()) as { result: number }
    return result
  }

  private async expire(key: string, seconds: number): Promise<void> {
    await fetch(`${this.url}/expire/${encodeURIComponent(key)}/${seconds}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
    })
  }
}
