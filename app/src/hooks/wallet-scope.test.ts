import {describe, expect, it} from 'vitest'
import {isStaleScope, rowsForScope, type WalletScoped, walletScopeKey, writeScoped} from './wallet-scope'

const EMPTY: readonly string[] = []
const A = walletScopeKey('group-a', 0)
const B = walletScopeKey('group-b', 0)

const painted = (key: string, rows: readonly string[]): WalletScoped<string> => ({key, rows})

describe('walletScopeKey', () => {
  it('separates two accounts of one wallet', () => {
    expect(walletScopeKey('group-a', 0)).not.toBe(walletScopeKey('group-a', 1))
  })

  it('separates two wallets', () => {
    expect(A).not.toBe(B)
  })

  it('separates one wallet on two networks', () => {
    // The same account on preprod and on mainnet holds different balances and a different
    // history; a key blind to the network would carry one straight into the other.
    expect(walletScopeKey('group-a', 0, 0)).not.toBe(walletScopeKey('group-a', 0, 1))
  })

  it('stays stable for callers that do not know a network', () => {
    // The portfolio keys without one; adding the parameter must not have moved its key.
    expect(walletScopeKey('group-a', 0)).toBe('group-a:0')
  })

  it('does not collide a network-qualified key with an unqualified one', () => {
    expect(walletScopeKey('group-a', 0)).not.toBe(walletScopeKey('group-a', 0, 0))
  })
})

describe('rowsForScope', () => {
  it('returns the rows when they describe this wallet', () => {
    expect(rowsForScope(painted(A, ['ada', 'link']), A, EMPTY)).toEqual(['ada', 'link'])
  })

  /**
   * The whole bug, as one assertion.
   *
   * Wallet B is selected and only wallet A has ever been fetched. Anything other than empty
   * here is A's balance rendered under B's name.
   */
  it('never returns another wallet rows', () => {
    expect(rowsForScope(painted(A, ['ada', 'link']), B, EMPTY)).toEqual([])
  })

  it('returns the same empty identity on a miss, so consumers do not re-render', () => {
    expect(rowsForScope(painted(A, ['ada']), B, EMPTY)).toBe(EMPTY)
  })
})

describe('isStaleScope', () => {
  // Drives `loading`: a settled fetch for the previous wallet is not a settled fetch for
  // this one, and reporting otherwise draws a confident zero over a funded wallet.
  it('is stale until something has been painted for this wallet', () => {
    expect(isStaleScope(painted(A, ['ada']), B)).toBe(true)
    expect(isStaleScope(painted(B, []), B)).toBe(false)
  })

  it('is not stale for an empty result that genuinely belongs to this wallet', () => {
    expect(isStaleScope(painted(B, []), B)).toBe(false)
  })
})

describe('writeScoped', () => {
  it('stamps a plain write with the current wallet', () => {
    expect(writeScoped(painted(A, ['ada']), B, ['dust'], EMPTY)).toEqual({key: B, rows: ['dust']})
  })

  /**
   * The prices-unavailable branch keeps whatever is already painted rather than blanking a
   * known balance. Scoping is what makes that safe: it can only keep *this* wallet's.
   */
  it('shows an updater this wallet rows, never the previous wallet', () => {
    const result = writeScoped(painted(A, ['ada', 'link']), B, (prev) => (prev.length > 0 ? prev : ['fallback']), EMPTY)
    expect(result).toEqual({key: B, rows: ['fallback']})
  })

  it('lets an updater keep rows that do belong to this wallet', () => {
    const result = writeScoped(painted(B, ['ada']), B, (prev) => (prev.length > 0 ? prev : ['fallback']), EMPTY)
    expect(result).toEqual({key: B, rows: ['ada']})
  })
})
