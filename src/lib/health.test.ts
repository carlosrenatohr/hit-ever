import { describe, expect, it } from 'vitest'
import { assessIngestionFreshness } from './health.js'

describe('assessIngestionFreshness', () => {
  it('reports operational when every provider wrote within the threshold', () => {
    const fresh = new Date(Date.now() - 60 * 60 * 1000).toISOString() // 1h ago
    const a = assessIngestionFreshness({ everest: fresh, global_connection: fresh }, 6)
    expect(a.stale).toBe(false)
    expect(a.staleProviders).toEqual([])
    expect(a.freshness.everest.hours_stale).toBeLessThan(1.1)
  })

  it('flags a provider that has not written within the threshold', () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() // 48h ago
    const a = assessIngestionFreshness({ everest: old, global_connection: new Date().toISOString() }, 6)
    expect(a.stale).toBe(true)
    expect(a.staleProviders).toEqual(['everest'])
  })

  it('treats a provider that never wrote as stale', () => {
    const a = assessIngestionFreshness({ everest: null, global_connection: new Date().toISOString() }, 6)
    expect(a.stale).toBe(true)
    expect(a.staleProviders).toEqual(['everest'])
    expect(a.freshness.everest.hours_stale).toBeNull()
  })

  it('respects a custom stale threshold', () => {
    const twoHours = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    expect(assessIngestionFreshness({ everest: twoHours }, 1).stale).toBe(true)
    expect(assessIngestionFreshness({ everest: twoHours }, 4).stale).toBe(false)
  })
})