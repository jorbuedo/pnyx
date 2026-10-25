import {describe, expect, it} from 'vitest'
import {outcomeForCode, validateCodeSet} from './pin-outcome'
import {DECOY_PROFILE_ID, DEFAULT_PROFILE_ID} from './profile-id'

describe('outcomeForCode', () => {
  it('opens the real profile for the real code, with no wipe', () => {
    expect(outcomeForCode('real')).toEqual({profileId: DEFAULT_PROFILE_ID, wipe: false})
  })

  it('opens the decoy for the decoy code', () => {
    expect(outcomeForCode('decoy')).toEqual({profileId: DECOY_PROFILE_ID, wipe: false})
  })

  it('opens the decoy for the wipe code — never the real profile, never a blank screen', () => {
    // The whole point: a coercer watching this sees an ordinary unlock into an
    // ordinary wallet. If the wipe code opened anything else, or showed a
    // "wiping" state, it would announce itself.
    expect(outcomeForCode('wipe')).toEqual({profileId: DECOY_PROFILE_ID, wipe: true})
  })

  it('sends the wipe and decoy codes to the same profile', () => {
    expect(outcomeForCode('wipe').profileId).toBe(outcomeForCode('decoy').profileId)
  })
})

describe('validateCodeSet', () => {
  it('accepts a real PIN on its own', () => {
    expect(validateCodeSet({real: '123456'})).toEqual({ok: true})
  })

  it('accepts a decoy of the same length as the real PIN', () => {
    expect(validateCodeSet({real: '123456', decoy: '654321'})).toEqual({ok: true})
  })

  it('rejects a decoy identical to the real PIN', () => {
    expect(validateCodeSet({real: '123456', decoy: '123456'})).toEqual({ok: false, reason: 'duplicate'})
  })

  it('rejects a wipe code identical to another code', () => {
    expect(validateCodeSet({real: '123456', wipe: '123456'})).toEqual({ok: false, reason: 'duplicate'})
  })

  it('accepts a wipe code of the same length as the other PINs', () => {
    // Same length on purpose: a different digit count is visible to whoever is
    // watching the screen, which would mark the emergency code as something
    // other than the normal PIN.
    expect(validateCodeSet({real: '123456', decoy: '111111', wipe: '999999'})).toEqual({ok: true})
  })

  it('ignores empty codes rather than treating them as duplicates', () => {
    expect(validateCodeSet({real: '123456', decoy: '', wipe: ''})).toEqual({ok: true})
  })
})
