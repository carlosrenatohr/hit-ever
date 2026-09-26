import { describe, expect, it } from 'vitest'
import { toIlikePattern } from './text.js'

describe('toIlikePattern', () => {
  it('expands vowels and ñ into LIKE char classes', () => {
    expect(toIlikePattern('Mendez')).toBe('m[eé][nñ]d[eé]z')
    expect(toIlikePattern('25001234')).toBe('25001234')
  })

  it('builds the same pattern from an uppercase term (ILIKE folds the pattern)', () => {
    expect(toIlikePattern('MENDEZ')).toBe(toIlikePattern('Mendez'))
  })
})
