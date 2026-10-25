import {deriveCardanoAccountXpub, deriveCardanoAddressBook} from '@pnyx/wallet'
import {Effect} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import {addressCredentials, paymentCredentialOf} from './address-credentials'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

/** A mainnet base address whose payment half is a script (type nibble 1) — a shared wallet's shape. */
const SCRIPT_PAYMENT =
  'addr1z9vcd07vpjluvr0v3hu8w9wvjhgrs9a2cwrtp6wn8ksrkwf627hhjyls27xwmke4e4ewn27rv3qcntakvp7wd53dqahq6wh2cd'
const REWARD = 'stake1uya90tmez0c90r8dmv6u6uhf40pkgsvf47mxql8x6gkswmsh4vdtq'

describe('addressCredentials', () => {
  let derived: {bech32: string; paymentKeyHashHex: string}

  beforeAll(async () => {
    const xpub = await Effect.runPromise(deriveCardanoAccountXpub(MNEMONIC))
    const book = await Effect.runPromise(deriveCardanoAddressBook(xpub, {count: 1}))
    const first = book.external[0]
    if (first === undefined) throw new Error('the derivation produced no external address')
    derived = {bech32: first.bech32, paymentKeyHashHex: first.paymentKeyHashHex}
  })

  // The load-bearing equivalence: reading the credential out of the address gives the
  // same bytes the derivation produced, so a row can record it without deriving.
  it('reads the same payment key hash the derivation produced', () => {
    expect(paymentCredentialOf(derived.bech32)).toBe(derived.paymentKeyHashHex)
  })

  it('reports a key payment credential as not a script, and finds the stake half', () => {
    const creds = addressCredentials(derived.bech32)
    expect(creds?.payment.isScript).toBe(false)
    expect(creds?.payment.hex).toHaveLength(56)
    expect(creds?.stake?.hex).toHaveLength(56)
    expect(creds?.stake?.isScript).toBe(false)
  })

  // ⚠️ The case the address table got wrong: a script address has no payment *key*
  // hash, and the writers stored the bech32 in that column instead of saying so.
  it('reads a script payment credential and marks it as one', () => {
    const creds = addressCredentials(SCRIPT_PAYMENT)
    expect(creds?.payment.isScript).toBe(true)
    expect(creds?.payment.hex).toHaveLength(56)
    expect(creds?.payment.hex).not.toBe(SCRIPT_PAYMENT)
    // Its stake half is an ordinary key, which is what makes it look like ours.
    expect(creds?.stake?.isScript).toBe(false)
  })

  it('tolerates surrounding whitespace', () => {
    expect(paymentCredentialOf(`  ${derived.bech32}\n`)).toBe(derived.paymentKeyHashHex)
  })

  it('answers null for an address with no payment half rather than inventing one', () => {
    expect(addressCredentials(REWARD)).toBeNull()
    expect(paymentCredentialOf(REWARD)).toBeNull()
  })

  it('answers null for things that are not addresses', () => {
    for (const input of ['', 'not-an-address', 'addr1notvalidbech32']) {
      expect(paymentCredentialOf(input), input).toBeNull()
    }
  })
})
