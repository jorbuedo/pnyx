import {describe, expect, it} from '@effect/vitest'
import * as Brands from '@evolution-sdk/review/Brands'
import {Effect} from 'effect'
import * as Address from './Address.js'
import * as Keys from './Keys.js'

/**
 * ⚠️ No layer. These used to be wrapped in `Effect.provide(e, EvolutionCodecLayer)` because every
 * tier operation carried `Codec` in its R channel; the tiers call Evolution directly now, so the
 * requirement is `never` and `Effect.runSync` takes them as they are. A `provide` reappearing here
 * means the service requirement came back.
 */
const run = <A, E>(e: Effect.Effect<A, E, never>) => Effect.runSync(e)

describe('the address tier', () => {
  const BECH32 = Brands.Bech32(
    'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7s5x7x4e49fkw9ydmrzsjdek5v45cyh5qqs8hsm9l2vcyutsszhdem',
  )

  it('round-trips bech32 through hex and back', () => {
    const back = run(Effect.flatMap(Address.fromBech32(BECH32), (hex) => Address.toBech32(hex)))
    expect(back).toBe(BECH32)
  })

  it('builds a base address from two credentials', () => {
    // The reason the tier exists: one call instead of a header byte and two concatenations, which
    // is where a wrong network id or a swapped credential gets in.
    const hex = Address.baseHex(0, '11'.repeat(28), '22'.repeat(28))
    expect(hex).toMatch(/^00/)
    expect(hex).toHaveLength(2 + 56 + 56)
  })

  it('maps a throw into the typed failure channel rather than propagating it', () => {
    // `Op.op`'s whole job. A caller composes these without a try/catch anywhere.
    const exit = Effect.runSyncExit(Address.toBech32('zz' as Brands.AddressHex))
    expect(exit._tag).toBe('Failure')
  })

  it('derives a public key from an extended private key', () => {
    // 96 bytes of extended private key in, the 32-byte public key out — NOT the 64-byte xpub, which
    // is the pair that gets confused: an xpub carries its chain code and this does not.
    const xprv = Brands.XprvHex(`10${'11'.repeat(30)}51${'11'.repeat(64)}`)
    const pub = run(Keys.publicKey(xprv))
    expect(pub).toMatch(/^[0-9a-f]{64}$/)
  })
})
