import { describe, expect, it } from 'vitest'
import { foldAccents } from './text.js'

describe('foldAccents', () => {
  it('folds Spanish accents to ASCII lowercase', () => {
    expect(foldAccents('Rodríguez Méndez Núñez')).toBe('rodriguez mendez nunez')
  })

  it('leaves plain terms untouched', () => {
    expect(foldAccents('25001234')).toBe('25001234')
  })

  it('folds uppercase input (ILIKE folds both sides anyway)', () => {
    expect(foldAccents('MENDEZ')).toBe('mendez')
  })

  it('produces a plain pattern — no LIKE bracket classes (they do not match in this cluster)', () => {
    expect(foldAccents('Ana').includes('[')).toBe(false)
  })
})