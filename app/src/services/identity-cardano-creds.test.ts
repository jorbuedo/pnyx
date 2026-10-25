import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {deriveIdentityCardanoCreds, parseIdentityCardanoCreds} from './identity-cardano-creds'

// The common test seed used across the Cardano suites.
const MNEMONIC = 'test walk nut penalty hip pave soap entry language right filter choice'

describe('deriveIdentityCardanoCreds', () => {
  it('derives a distinct payment and stake key hash', async () => {
    const creds = await Effect.runPromise(deriveIdentityCardanoCreds(MNEMONIC))

    // blake2b-224 → 28 bytes → 56 hex chars.
    expect(creds.paymentKeyHashHex).toMatch(/^[0-9a-f]{56}$/)
    expect(creds.stakeKeyHashHex).toMatch(/^[0-9a-f]{56}$/)
    expect(creds.paymentKeyHashHex).not.toBe(creds.stakeKeyHashHex)
  })

  it('is deterministic for the same mnemonic', async () => {
    const a = await Effect.runPromise(deriveIdentityCardanoCreds(MNEMONIC))
    const b = await Effect.runPromise(deriveIdentityCardanoCreds(MNEMONIC))
    expect(a).toEqual(b)
  })

  it('derives the same hashes the register services sign with', async () => {
    // koios-register signs with CIP-1852 account 0, role 2, index 0 (stake) and
    // steelswap-register with account 0, role 0, index 0 (payment). If this
    // module ever drifts from those paths, review would attribute the ID's own
    // transactions to a stranger — so pin the paths, not just the format.
    const {Keys} = await import('@pnyx/cardano-core')
    const expected = await Effect.runPromise(
      Effect.gen(function* () {
        const root = yield* Keys.rootKeyFromMnemonic(MNEMONIC)
        const payment = yield* Keys.keyHashOf(yield* Keys.deriveCip1852(root, 0, 0, 0))
        const stake = yield* Keys.keyHashOf(yield* Keys.deriveCip1852(root, 0, 2, 0))
        return {paymentKeyHashHex: payment, stakeKeyHashHex: stake}
      }),
    )

    expect(await Effect.runPromise(deriveIdentityCardanoCreds(MNEMONIC))).toEqual(expected)
  })
})

describe('parseIdentityCardanoCreds', () => {
  it('round-trips a persisted pair', () => {
    const creds = {paymentKeyHashHex: 'aa'.repeat(28), stakeKeyHashHex: 'bb'.repeat(28)}
    expect(parseIdentityCardanoCreds(JSON.stringify(creds))).toEqual(creds)
  })

  it('treats absence as absence', () => {
    expect(parseIdentityCardanoCreds(null)).toBeNull()
    expect(parseIdentityCardanoCreds(undefined)).toBeNull()
    expect(parseIdentityCardanoCreds('')).toBeNull()
  })

  it('rejects malformed payloads rather than returning half a pair', () => {
    expect(parseIdentityCardanoCreds('not json')).toBeNull()
    expect(parseIdentityCardanoCreds('null')).toBeNull()
    expect(parseIdentityCardanoCreds('"a string"')).toBeNull()
    expect(parseIdentityCardanoCreds(JSON.stringify({paymentKeyHashHex: 'aa'}))).toBeNull()
    expect(parseIdentityCardanoCreds(JSON.stringify({stakeKeyHashHex: 'bb'}))).toBeNull()
    expect(parseIdentityCardanoCreds(JSON.stringify({paymentKeyHashHex: '', stakeKeyHashHex: 'bb'}))).toBeNull()
  })
})
