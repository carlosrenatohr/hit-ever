import { afterEach, describe, expect, it, vi } from 'vitest'
import { Cooldown } from './ratelimit.js'

afterEach(() => vi.unstubAllGlobals())

function makeFetch(results: Array<{ result: number }>) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      return new Response(JSON.stringify(results.shift() ?? { result: 1 }), { status: 200 })
    }),
  )
  return calls
}

describe('Cooldown', () => {
  it('allows the first call in the window and sets the expiry', async () => {
    const calls = makeFetch([{ result: 1 }, { result: 1 }])
    const cd = new Cooldown('https://u.upstash.io', 't', 300)
    const r = await cd.check('refresh:123')
    expect(r).toEqual({ allowed: true, retryAfterSeconds: 0 })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('/incr/cd%3Arefresh%3A123')
    expect(calls[1]).toContain('/expire/cd%3Arefresh%3A123/300')
  })

  it('blocks a second call and reports the remaining TTL', async () => {
    const calls = makeFetch([{ result: 2 }, { result: 250 }])
    const cd = new Cooldown('https://u.upstash.io', 't', 300)
    const r = await cd.check('refresh:123')
    expect(r).toEqual({ allowed: false, retryAfterSeconds: 250 })
    expect(calls[1]).toContain('/ttl/cd%3Arefresh%3A123')
  })

  it('fails open when the backend errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom')
      }),
    )
    const cd = new Cooldown('https://u.upstash.io', 't', 300)
    const r = await cd.check('refresh:123')
    expect(r).toEqual({ allowed: true, retryAfterSeconds: 0 })
  })
})
