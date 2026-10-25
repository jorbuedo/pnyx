import type {WalletSource} from '@pnyx/wallet'
import {describe, expect, it} from 'vitest'
import {canSpendForLink, spendCapability} from './link-action-wallets'

const ALL_SOURCES: readonly WalletSource[] = ['mnemonic', 'hardware', 'read-only', 'imported-xpriv', 'multisig']

describe('spendCapability', () => {
  it('says a key wallet signs alone', () => {
    // Hardware needs the device present, which the ceremony asks for when it gets
    // there — a prompt, not an impossibility.
    for (const source of ['mnemonic', 'hardware', 'imported-xpriv'] as const) {
      expect(spendCapability(source)).toBe('signs-alone')
    }
  })

  it('says a watch-only wallet cannot sign at all', () => {
    expect(spendCapability('read-only')).toBe('cannot-sign')
  })

  it('offers a shared wallet, and names what confirming will do', () => {
    // It can pay — the app builds a script spend, signs our share and hands it to
    // the co-sign rail. Hiding it would decide for the user that gathering is not
    // worth it; what they are owed is the consequence, so this is a capability and
    // not an exclusion.
    expect(spendCapability('multisig')).toBe('needs-co-signers')
    expect(canSpendForLink('multisig')).toBe(true)
  })

  it('answers for every source in the union', () => {
    // A source falling through an assumption is the bug this shape prevents; the
    // consequence here is a wallet offered for a spend it cannot complete.
    for (const source of ALL_SOURCES) expect(spendCapability(source)).not.toBeUndefined()
  })

  it('treats an unknown wallet as signing rather than hiding it', () => {
    // `undefined` is a group whose primary chain wallet has not loaded. Hiding it
    // would make the list silently shorter than the user's wallet list; the funnel
    // is where the real signer check happens.
    expect(spendCapability(undefined)).toBe('signs-alone')
  })

  it('excludes exactly the wallets that cannot sign', () => {
    for (const source of ALL_SOURCES) {
      expect(canSpendForLink(source)).toBe(spendCapability(source) !== 'cannot-sign')
    }
  })
})
