import {describe, expect, it} from 'vitest'

import {isMidnightAssetId, midnightAssetId, parseMidnightAssetId} from './midnight-asset-id'
import {NIGHT_TOKEN_TYPE} from './unshielded-utxo-set'

describe('midnight asset ids', () => {
  it('round-trips both rails', () => {
    for (const rail of ['unshielded', 'shielded'] as const) {
      const id = midnightAssetId({rail, tokenType: NIGHT_TOKEN_TYPE})
      expect(parseMidnightAssetId(id)).toEqual({rail, tokenType: NIGHT_TOKEN_TYPE})
    }
  })

  it('keeps the two rails apart for the same token type', () => {
    // The same token type is a different holding on each rail, so the ids must differ.
    expect(midnightAssetId({rail: 'unshielded', tokenType: NIGHT_TOKEN_TYPE})).not.toBe(
      midnightAssetId({rail: 'shielded', tokenType: NIGHT_TOKEN_TYPE}),
    )
  })

  it('normalises case, so a row and a route agree', () => {
    expect(parseMidnightAssetId('midnight:AABB')).toEqual({rail: 'unshielded', tokenType: 'aabb'})
  })

  it('recognises only its own ids', () => {
    expect(isMidnightAssetId(midnightAssetId({rail: 'unshielded', tokenType: 'aa'}))).toBe(true)
    // A Cardano asset id, and ADA's empty id.
    expect(isMidnightAssetId('9c6cd01df2299fcb.0014df104c494e4b')).toBe(false)
    expect(isMidnightAssetId('')).toBe(false)
  })

  it('refuses a malformed id rather than resolving it to a plausible empty holding', () => {
    for (const bad of ['midnight:', 'midnight:shielded:', 'midnight:zz', 'midnight:shielded:nothex', 'ada']) {
      expect(parseMidnightAssetId(bad)).toBeNull()
    }
  })
})
