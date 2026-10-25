// Zero-fee normalization: a balancing tx whose only content is an empty DustActions must
// be dropped from the recipe (the node rejects it as NotNormalized — 1010 / custom 117).
import {describe, expect, it} from 'vitest'
import {type BalancingTxLike, isNoopDustBalancing, patchNoopDustBalancing} from './balancing.js'

const emptyDustTx = (): BalancingTxLike => ({
  intents: new Map([[2, {dustActions: {spends: [], registrations: []}}]]),
})

describe('isNoopDustBalancing', () => {
  it('detects the zero-fee empty-DustActions shape', () => {
    expect(isNoopDustBalancing(emptyDustTx())).toBe(true)
  })

  it('keeps balancing txs that actually spend dust', () => {
    expect(
      isNoopDustBalancing({
        intents: new Map([[2, {dustActions: {spends: [{}], registrations: []}}]]),
      }),
    ).toBe(false)
  })

  it('keeps balancing txs with registrations, offers, actions, or zswap content', () => {
    expect(
      isNoopDustBalancing({
        intents: new Map([[2, {dustActions: {spends: [], registrations: [{}]}}]]),
      }),
    ).toBe(false)
    expect(
      isNoopDustBalancing({
        intents: new Map([[2, {dustActions: {spends: [], registrations: []}, guaranteedUnshieldedOffer: {}}]]),
      }),
    ).toBe(false)
    expect(
      isNoopDustBalancing({
        intents: new Map([[2, {dustActions: {spends: [], registrations: []}, actions: [{}]}]]),
      }),
    ).toBe(false)
    expect(
      isNoopDustBalancing({
        intents: new Map([[2, {dustActions: {spends: [], registrations: []}}]]),
        guaranteedOffer: {},
      }),
    ).toBe(false)
  })

  it('does not classify empty or intent-less transactions as dust no-ops', () => {
    expect(isNoopDustBalancing({})).toBe(false)
    expect(isNoopDustBalancing({intents: new Map()})).toBe(false)
  })
})

describe('patchNoopDustBalancing', () => {
  it('drops a no-op balancing transaction from the unbound recipe', async () => {
    const facade = {
      balanceUnboundTransaction: async () => ({
        type: 'UNBOUND_TRANSACTION',
        baseTransaction: 'base',
        balancingTransaction: emptyDustTx(),
      }),
    }
    patchNoopDustBalancing(facade)
    const recipe = (await facade.balanceUnboundTransaction()) as {
      balancingTransaction?: unknown
      baseTransaction?: unknown
    }
    expect(recipe.balancingTransaction).toBeUndefined()
    expect(recipe.baseTransaction).toBe('base')
  })

  it('leaves fee-bearing recipes untouched', async () => {
    const balancing = {intents: new Map([[2, {dustActions: {spends: [{}], registrations: []}}]])}
    const facade = {
      balanceUnboundTransaction: async () => ({
        type: 'UNBOUND_TRANSACTION',
        baseTransaction: 'base',
        balancingTransaction: balancing,
      }),
    }
    patchNoopDustBalancing(facade)
    const recipe = (await facade.balanceUnboundTransaction()) as {balancingTransaction?: unknown}
    expect(recipe.balancingTransaction).toBe(balancing)
  })
})
