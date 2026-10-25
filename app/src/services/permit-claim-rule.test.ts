import {describe, expect, it} from 'vitest'
import type {HandleOffer} from './handle-offer-rule'
import type {WalletPermits} from './permit-balances'
import {permitClaimDecision} from './permit-claim-rule'

const wallet = (groupId: string, accountIndex: number, byTier?: ReadonlyMap<number, bigint>): WalletPermits => ({
  wallet: {groupId, accountIndex, label: groupId},
  byTier,
})
const priced: HandleOffer = {kind: 'priced', tier: 3, price: 100n}
const A = {groupId: 'a', accountIndex: 0}

describe('permitClaimDecision', () => {
  it('needs no permit for a free tier', () => {
    expect(permitClaimDecision({offer: {kind: 'free', tier: 6}, wallets: [], selected: A})).toEqual({kind: 'free'})
  })

  // Already bound; only `setPrimaryName` is missing, and that spends nothing.
  it('needs no permit to finish a name that is already yours', () => {
    expect(permitClaimDecision({offer: {kind: 'yours', tier: 2}, wallets: [], selected: A})).toEqual({kind: 'free'})
  })

  it('is ready when the selected wallet holds the tier', () => {
    const wallets = [wallet('a', 0, new Map([[3, 1n]]))]
    expect(permitClaimDecision({offer: priced, wallets, selected: A})).toEqual({kind: 'ready'})
  })

  // The case the whole rule exists for: the permit is owned, just not by the wallet that would spend it.
  it('names the wallet to switch to when another one holds it', () => {
    const wallets = [wallet('a', 0, new Map()), wallet('b', 2, new Map([[3, 1n]]))]
    const decision = permitClaimDecision({offer: priced, wallets, selected: A})
    expect(decision.kind).toBe('switch-wallet')
    expect(decision.kind === 'switch-wallet' && decision.wallet).toEqual({groupId: 'b', accountIndex: 2, label: 'b'})
  })

  // Accounts are wallets here: two accounts of one group hold separately, and a pinned index would
  // report the wrong one.
  it('treats a second account of the same group as a different wallet', () => {
    const wallets = [wallet('a', 0, new Map()), wallet('a', 1, new Map([[3, 1n]]))]
    const decision = permitClaimDecision({offer: priced, wallets, selected: A})
    expect(decision.kind === 'switch-wallet' && decision.wallet.accountIndex).toBe(1)
  })

  it('reports no permit only when every wallet was readable', () => {
    expect(permitClaimDecision({offer: priced, wallets: [wallet('a', 0, new Map())], selected: A})).toEqual({
      kind: 'no-permit',
    })
  })

  // ⚠️ An unsynced wallet cannot support "you hold none" — that is the failed-read-as-empty-wallet
  // class, and it would send someone off to buy a permit they already own.
  it('says unknown rather than none when a wallet has never synced', () => {
    const wallets = [wallet('a', 0, new Map()), wallet('b', 0, undefined)]
    expect(permitClaimDecision({offer: priced, wallets, selected: A})).toEqual({kind: 'unknown'})
  })

  // A tier that is held elsewhere outranks an unsynced wallet: we found the permit, so nothing is
  // uncertain any more.
  it('prefers a found permit over an unsynced wallet', () => {
    const wallets = [wallet('a', 0, new Map()), wallet('b', 0, undefined), wallet('c', 0, new Map([[3, 1n]]))]
    expect(permitClaimDecision({offer: priced, wallets, selected: A}).kind).toBe('switch-wallet')
  })

  it('never counts another tier toward this one', () => {
    const wallets = [wallet('a', 0, new Map([[0, 9n]]))]
    expect(permitClaimDecision({offer: priced, wallets, selected: A})).toEqual({kind: 'no-permit'})
  })

  it('is unavailable for a tier this build cannot obtain', () => {
    expect(permitClaimDecision({offer: {kind: 'unavailable', tier: 1}, wallets: [], selected: A})).toEqual({
      kind: 'unavailable',
    })
  })

  it('handles no wallet being selected', () => {
    const wallets = [wallet('b', 0, new Map([[3, 1n]]))]
    expect(permitClaimDecision({offer: priced, wallets, selected: undefined}).kind).toBe('switch-wallet')
  })
})
