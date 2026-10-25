import {describe, expect, it} from 'vitest'
import type {AtcOrder} from './atc-client'
import {ammStatus, atcStatus, filterOrders, mergeOrders, normalizeAmmOrder, normalizeAtcOrder} from './order-model'
import type {SwapOrder} from './types'

const POLICY = 'a'.repeat(56)
const SNEK = `${POLICY}534e454b`

const ammOrder = (over: Partial<SwapOrder> = {}): SwapOrder => ({
  txHash: 'amm1',
  status: 'OPEN',
  orderType: 'SWAP',
  timeSec: 1_000,
  pair: ['lovelace', SNEK],
  offer: [{unit: 'lovelace', amount: '100000000'}],
  minReceive: [{unit: SNEK, amount: '50000'}],
  received: [],
  remaining: [{unit: 'lovelace', amount: '100000000'}],
  fillReason: null,
  legCount: 1,
  legs: [{kind: 'ammSwap', dex: 'MinswapV2', poolId: 'p', input: null, output: null, batcherFee: null}],
  source: 'steelswap',
  ...over,
})

const atcOrder = (over: Partial<AtcOrder> = {}): AtcOrder => ({
  orderId: 'atc1#0',
  pair: ['lovelace', SNEK],
  direction: 'buy',
  offer: {unit: 'lovelace', amount: '500000000'},
  ask: {unit: SNEK, amount: '210000'},
  swapPrice: {numerator: '21', denominator: '50'},
  ownerStake: 'stake1xyz',
  status: 'OPEN',
  available: '500000000',
  ageSlots: 300,
  ...over,
})

describe('status folding', () => {
  it('folds the AMM rail LIMIT status to open — it is a resting AMM order, not an ATC one', () => {
    // Two different meanings of "limit" collide here: the AMM aggregator uses
    // LIMIT for a resting order on a venue that has them, which is not the ATC
    // limit book. Both are simply "open" to the user.
    expect(ammStatus('LIMIT')).toBe('open')
    expect(ammStatus('OPEN')).toBe('open')
  })

  it('maps every documented AMM status, and an unknown one to `unknown`', () => {
    expect(ammStatus('MEMPOOL')).toBe('mempool')
    expect(ammStatus('PARTIALLY_FILLED')).toBe('partiallyFilled')
    expect(ammStatus('PARTIALLY_CANCELLED')).toBe('partiallyCancelled')
    expect(ammStatus('FILLED')).toBe('filled')
    expect(ammStatus('CANCELLED')).toBe('cancelled')
    expect(ammStatus('ERROR')).toBe('error')
    expect(ammStatus('MIXED')).toBe('mixed')
    expect(ammStatus('ROLLED_BACK')).toBe('rolledBack')
    expect(ammStatus('SOMETHING_NEW')).toBe('unknown')
  })

  it('maps the ATC rail, whose vocabulary is only four values', () => {
    expect(atcStatus('OPEN')).toBe('open')
    expect(atcStatus('FILLED')).toBe('filled')
    expect(atcStatus('CANCELLED')).toBe('cancelled')
    expect(atcStatus('LIMIT')).toBe('open')
  })
})

describe('normalizeAmmOrder', () => {
  it('names the venue from the first leg', () => {
    expect(normalizeAmmOrder(ammOrder()).venue).toBe('MinswapV2')
  })

  it('refuses to mark a mempool order cancellable — it is not indexed yet', () => {
    // A cancel on an unindexed order answers `not_found`, so offering the
    // action would produce a failure the user cannot act on.
    const o = normalizeAmmOrder(ammOrder({status: 'MEMPOOL', legs: []}))
    expect(o.status).toBe('mempool')
    expect(o.cancellable).toBe(false)
    expect(o.venue).toBeNull()
  })

  it('marks a partially filled order cancellable — value is still resting', () => {
    expect(normalizeAmmOrder(ammOrder({status: 'PARTIALLY_FILLED'})).cancellable).toBe(true)
  })

  it('does not mark a terminal order cancellable', () => {
    for (const s of ['FILLED', 'CANCELLED', 'ERROR', 'ROLLED_BACK']) {
      expect(normalizeAmmOrder(ammOrder({status: s})).cancellable).toBe(false)
    }
  })
})

describe('normalizeAtcOrder', () => {
  it('derives the filled part from offer − available, in the OFFERED token', () => {
    // ATC reports what is LEFT, never what came back. Reading `available` as a
    // received amount would show a fresh order as fully filled.
    const o = normalizeAtcOrder(atcOrder({available: '200000000'}))
    expect(o.received).toEqual([{unit: 'lovelace', amount: '300000000'}])
    expect(o.remaining).toEqual([{unit: 'lovelace', amount: '200000000'}])
  })

  it('reports nothing received while the order is untouched', () => {
    expect(normalizeAtcOrder(atcOrder()).received).toEqual([])
  })

  it('leaves the time null without a chain tip rather than inventing one', () => {
    // `ageSlots` alone cannot become a timestamp, and a fabricated one would
    // silently misorder the merged list.
    expect(normalizeAtcOrder(atcOrder()).timeSec).toBeNull()
  })

  it('converts ageSlots against a supplied tip', () => {
    expect(normalizeAtcOrder(atcOrder({ageSlots: 300}), {slot: 100_000, atSec: 5_000}).timeSec).toBe(4_700)
  })

  it('keeps the id as txHash#index but exposes the bare hash too', () => {
    const o = normalizeAtcOrder(atcOrder())
    expect(o.id).toBe('atc1#0')
    expect(o.txHash).toBe('atc1')
  })
})

describe('mergeOrders', () => {
  it('sorts newest first across both rails', () => {
    const merged = mergeOrders(
      [normalizeAmmOrder(ammOrder({txHash: 'a', timeSec: 100}))],
      [normalizeAtcOrder(atcOrder({orderId: 'b#0', ageSlots: 50}), {slot: 1, atSec: 250})],
    )
    expect(merged.map((o) => o.id)).toEqual(['b#0', 'a'])
  })

  it('puts undated orders last instead of dropping them', () => {
    const merged = mergeOrders(
      [normalizeAmmOrder(ammOrder({txHash: 'dated', timeSec: 10}))],
      [normalizeAtcOrder(atcOrder({orderId: 'undated#0'}))],
    )
    expect(merged.map((o) => o.id)).toEqual(['dated', 'undated#0'])
  })
})

describe('filterOrders', () => {
  const orders = [
    normalizeAmmOrder(ammOrder({txHash: 'open', status: 'OPEN'})),
    normalizeAmmOrder(ammOrder({txHash: 'filled', status: 'FILLED'})),
    normalizeAmmOrder(ammOrder({txHash: 'cancelled', status: 'CANCELLED'})),
    normalizeAmmOrder(ammOrder({txHash: 'mempool', status: 'MEMPOOL'})),
    normalizeAtcOrder(atcOrder({orderId: 'limitopen#0', status: 'OPEN'})),
  ]

  it('counts a mempool order as open — it is in flight, not finished', () => {
    expect(
      filterOrders(orders, 'open', 'both')
        .map((o) => o.id)
        .sort(),
    ).toEqual(['limitopen#0', 'mempool', 'open'])
  })

  it('narrows to one rail', () => {
    expect(filterOrders(orders, 'all', 'limit').map((o) => o.id)).toEqual(['limitopen#0'])
    expect(
      filterOrders(orders, 'open', 'amm')
        .map((o) => o.id)
        .sort(),
    ).toEqual(['mempool', 'open'])
  })

  it('groups the failure-ish statuses under cancelled', () => {
    const withError = [...orders, normalizeAmmOrder(ammOrder({txHash: 'err', status: 'ERROR'}))]
    expect(
      filterOrders(withError, 'cancelled', 'both')
        .map((o) => o.id)
        .sort(),
    ).toEqual(['cancelled', 'err'])
  })
})

describe('a real /api/v2/orders row', () => {
  // Captured from mainnet on 2026-09-03 (tx 92a90509…25b9, Minswap advanced
  // order). Two things this shape proves, both of which produced blank rows:
  // the top-level aggregates are EMPTY on a FILLED order, and the legs name
  // their amounts `offer`/`received`, not `input`/`output`.
  const NIGHT = '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa4e49474854'
  const live: SwapOrder = {
    txHash: '92a905099946695332e1ef2afbc12a38cdbc280b9335e370fa5e7626ae8425b9',
    status: 'FILLED',
    orderType: 'SWAP',
    timeSec: 1_788_402_636,
    pair: null,
    offer: [],
    minReceive: [],
    received: [],
    remaining: [],
    fillReason: 'ADVANCED_ORDER_TYPE',
    legCount: 2,
    legs: [
      {
        kind: 'ammSwap',
        dex: 'MinswapV2',
        poolId: '',
        input: {unit: NIGHT, amount: '3673469472'},
        output: {unit: 'lovelace', amount: '424248353'},
        batcherFee: null,
      },
      {
        kind: 'ammSwap',
        dex: 'MinswapV2',
        poolId: '',
        input: {unit: NIGHT, amount: '26326530528'},
        output: {unit: 'lovelace', amount: '2500000000'},
        batcherFee: null,
      },
    ],
    source: 'minswap',
  }

  it('sums the legs when the top-level aggregate is empty', () => {
    const o = normalizeAmmOrder(live)
    expect(o.offer).toEqual([{unit: NIGHT, amount: '30000000000'}])
    expect(o.received).toEqual([{unit: 'lovelace', amount: '2924248353'}])
  })

  it('still prefers the top-level aggregate when the API populates it', () => {
    const withTotals = {...live, offer: [{unit: NIGHT, amount: '1'}]}
    expect(normalizeAmmOrder(withTotals).offer).toEqual([{unit: NIGHT, amount: '1'}])
  })
})

describe('mergeOrders dedupe', () => {
  it('collapses two rows that share a rail and id', () => {
    // The live list repeats a logical order — an advanced order with several
    // executions, and a MEMPOOL item joined by its indexed self on page one.
    // Two rows with one id is a React duplicate-key warning and an ambiguous
    // cancel target.
    const a = normalizeAmmOrder(ammOrder({txHash: 'same', timeSec: 10}))
    const b = normalizeAmmOrder(ammOrder({txHash: 'same', timeSec: 10, status: 'FILLED'}))
    expect(mergeOrders([a, b], [])).toHaveLength(1)
  })

  it('keeps the same id when it belongs to a different rail', () => {
    const amm = normalizeAmmOrder(ammOrder({txHash: 'x'}))
    const limit = normalizeAtcOrder(atcOrder({orderId: 'x'}))
    expect(mergeOrders([amm], [limit])).toHaveLength(2)
  })
})

describe('the Open filter and the Cancel action agree', () => {
  // These were two hand-written status lists, and they drifted: `MIXED` is
  // cancellable but was missing from `open`, so the Open tab came back empty
  // while the rows under All still offered "Cancel order".
  const EVERY_STATUS = [
    'MEMPOOL',
    'OPEN',
    'LIMIT',
    'PARTIALLY_FILLED',
    'PARTIALLY_CANCELLED',
    'FILLED',
    'CANCELLED',
    'ERROR',
    'MIXED',
    'ROLLED_BACK',
  ]

  it('lists every cancellable order under Open', () => {
    const all = EVERY_STATUS.map((s, i) => normalizeAmmOrder(ammOrder({txHash: `o${i}`, status: s})))
    const cancellable = all.filter((o) => o.cancellable).map((o) => o.id)
    const underOpen = new Set(filterOrders(all, 'open', 'both').map((o) => o.id))
    for (const id of cancellable) expect(underOpen.has(id)).toBe(true)
    // And it is not vacuous — some statuses really are cancellable.
    expect(cancellable.length).toBeGreaterThan(0)
  })

  it('does not file a settled order under Open', () => {
    const filled = normalizeAmmOrder(ammOrder({txHash: 'f', status: 'FILLED'}))
    expect(filterOrders([filled], 'open', 'both')).toEqual([])
  })

  it('keeps a partially-cancelled order out of Cancelled — it still has work outstanding', () => {
    const pc = normalizeAmmOrder(ammOrder({txHash: 'pc', status: 'PARTIALLY_CANCELLED'}))
    expect(filterOrders([pc], 'cancelled', 'both')).toEqual([])
    expect(filterOrders([pc], 'open', 'both')).toHaveLength(1)
  })
})

describe('MIXED is terminal, not resting', () => {
  // The API's own wording: MIXED is "when the executions ENDED in different
  // states". Reading it as a middle state offered Cancel on seven settled
  // orders, and every attempt came back `already_executed`.
  it('does not offer to cancel a mixed order', () => {
    expect(normalizeAmmOrder(ammOrder({status: 'MIXED'})).cancellable).toBe(false)
  })

  it('does not file a mixed order under Open', () => {
    const mixed = normalizeAmmOrder(ammOrder({txHash: 'm', status: 'MIXED'}))
    expect(filterOrders([mixed], 'open', 'both')).toEqual([])
  })

  it('still treats partially-cancelled as resting — part of it IS still open', () => {
    expect(normalizeAmmOrder(ammOrder({status: 'PARTIALLY_CANCELLED'})).cancellable).toBe(true)
  })
})
