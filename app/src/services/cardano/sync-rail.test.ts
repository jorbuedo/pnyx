import type {WalletImplementation, WalletSource} from '@pnyx/wallet'
import {describe, expect, it} from 'vitest'
import {cardanoRailSyncIsSupported} from './sync-rail'

const kind = (over: {
  readonly source?: WalletSource
  readonly implementation?: WalletImplementation | undefined
}): {readonly source: WalletSource; readonly implementation: WalletImplementation | undefined} => ({
  source: 'mnemonic',
  implementation: 'cip1852',
  ...over,
})

describe('cardanoRailSyncIsSupported', () => {
  it('schedules an ordinary derived wallet', () => {
    expect(cardanoRailSyncIsSupported(kind({}))).toBe(true)
  })

  it('schedules a hardware wallet, which derives the same way', () => {
    // The report this whole line of work came from was a Ledger import, so this is the case
    // that must not be excluded by a guard aimed at watch-only.
    expect(cardanoRailSyncIsSupported(kind({source: 'hardware'}))).toBe(true)
  })

  it('schedules a bip44 wallet', () => {
    expect(cardanoRailSyncIsSupported(kind({implementation: 'bip44'}))).toBe(true)
  })

  // ⚠️ The two spellings are the trap. `WalletSource` says 'read-only' and
  // `WalletImplementation` says 'readOnly', so a guard checking one admits the other — and
  // a watch-only wallet resolved here would fetch under 'owned' instead of 'all', dropping
  // every account UTxO outside the derived set.
  it('excludes a watch-only wallet by its source spelling', () => {
    expect(cardanoRailSyncIsSupported(kind({source: 'read-only'}))).toBe(false)
  })

  it('excludes a watch-only wallet by its implementation spelling', () => {
    expect(cardanoRailSyncIsSupported(kind({implementation: 'readOnly'}))).toBe(false)
  })

  it('excludes a shared wallet by either field, since its rail comes from compiled scripts', () => {
    expect(cardanoRailSyncIsSupported(kind({source: 'multisig'}))).toBe(false)
    expect(cardanoRailSyncIsSupported(kind({implementation: 'cip1854'}))).toBe(false)
  })

  it('schedules a group whose chain config is absent rather than refusing to sync it', () => {
    // A missing chain config is not evidence of a special wallet kind, and treating it as
    // one would silently leave an ordinary wallet with no scheduled fetch at all.
    expect(cardanoRailSyncIsSupported(kind({implementation: undefined}))).toBe(true)
  })
})
