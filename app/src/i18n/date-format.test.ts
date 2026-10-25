import {describe, expect, it} from 'vitest'
import {formatTimeOfDay, getDateTimeFormat} from './date-format'

describe('getDateTimeFormat', () => {
  // ⚠️ The whole point: `Date#toLocaleTimeString` builds a formatter per call, and two activity-row
  // renderers called it per row, per render — 551 ms of a 12 s window on a wallet with a long history.
  // Identity is the assertion, because "it returns the right string" would pass without any caching.
  it('returns the same formatter instance for the same locale and options', () => {
    const a = getDateTimeFormat('en-US', {hour: 'numeric', minute: '2-digit'})
    const b = getDateTimeFormat('en-US', {hour: 'numeric', minute: '2-digit'})
    expect(a).toBe(b)
  })

  it('keeps different locales and different option sets apart', () => {
    const en = getDateTimeFormat('en-US', {hour: 'numeric'})
    const de = getDateTimeFormat('de-DE', {hour: 'numeric'})
    const other = getDateTimeFormat('en-US', {hour: 'numeric', minute: '2-digit'})
    expect(en).not.toBe(de)
    expect(en).not.toBe(other)
  })

  // The rows passed `undefined` for the locale (runtime default) before this existed; that has to stay
  // a cacheable key rather than being resolved to something else.
  it('caches the runtime-default locale under its own key', () => {
    expect(getDateTimeFormat(undefined, {hour: 'numeric'})).toBe(getDateTimeFormat(undefined, {hour: 'numeric'}))
  })
})

describe('formatTimeOfDay', () => {
  it('renders hour and minute in the locale convention', () => {
    // Fixed instant, explicit locale + zone-free comparison: assert the shape, not the wall clock.
    const iso = new Date(2026, 7, 27, 14, 5).toISOString()
    expect(formatTimeOfDay(iso, 'en-US')).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/i)
    expect(formatTimeOfDay(iso, 'de-DE')).toMatch(/\d{1,2}:\d{2}/)
  })

  it('takes epoch millis as well as an ISO string', () => {
    const at = Date.UTC(2026, 7, 27, 14, 5)
    expect(formatTimeOfDay(at, 'en-US')).toBe(formatTimeOfDay(new Date(at).toISOString(), 'en-US'))
  })
})
