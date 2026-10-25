import {describe, expect, it} from 'vitest'
import {isPinRequired, parsePinMode} from './pin-required'

const base = {configured: true, mode: 'coldStart', isColdStart: false, isArmed: false} as const

describe('isPinRequired', () => {
  it('never asks when no PIN is configured', () => {
    for (const mode of ['everyUnlock', 'coldStart', 'armed'] as const) {
      expect(isPinRequired({...base, configured: false, mode, isColdStart: true, isArmed: true})).toBe(false)
    }
  })

  it('always asks in everyUnlock mode', () => {
    expect(isPinRequired({...base, mode: 'everyUnlock'})).toBe(true)
    expect(isPinRequired({...base, mode: 'everyUnlock', isColdStart: true})).toBe(true)
  })

  it('asks on a cold start but not a warm re-lock in coldStart mode', () => {
    expect(isPinRequired({...base, mode: 'coldStart', isColdStart: true})).toBe(true)
    expect(isPinRequired({...base, mode: 'coldStart', isColdStart: false})).toBe(false)
  })

  it('stays silent in armed mode until armed', () => {
    expect(isPinRequired({...base, mode: 'armed', isColdStart: true})).toBe(false)
    expect(isPinRequired({...base, mode: 'armed', isArmed: true})).toBe(true)
  })

  it('honours the armed flag over every mode', () => {
    // A manual lock means ask, full stop — otherwise "lock now" would be a
    // no-op for anyone whose mode happened not to fire.
    for (const mode of ['everyUnlock', 'coldStart', 'armed'] as const) {
      expect(isPinRequired({...base, mode, isColdStart: false, isArmed: true})).toBe(true)
    }
  })
})

describe('parsePinMode', () => {
  it('accepts the three known modes', () => {
    expect(parsePinMode('everyUnlock')).toBe('everyUnlock')
    expect(parsePinMode('coldStart')).toBe('coldStart')
    expect(parsePinMode('armed')).toBe('armed')
  })

  it('returns undefined for anything else rather than guessing a default', () => {
    expect(parsePinMode('always')).toBeUndefined()
    expect(parsePinMode(null)).toBeUndefined()
    expect(parsePinMode(7)).toBeUndefined()
  })
})
