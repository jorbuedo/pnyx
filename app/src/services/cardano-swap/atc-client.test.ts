import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import type {FetchLike} from '../cardano-assets/token-metadata'
import {buildAtcClose, buildAtcOrder, fetchAtcOrders, fetchAtcQuote, parseAtcOrder} from './atc-client'

const POLICY = 'a'.repeat(56)
const SNEK = `${POLICY}534e454b`

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(Effect.either(e))

/**
 * ATC is keyless, so a stub that answers the CIP-8 mint would hide a regression:
 * any auth request here is a bug, and this throws on one.
 */
const atcStub = (body: unknown, opts: {status?: number; ok?: boolean} = {}) => {
  let sentBody: Record<string, unknown> = {}
  let sentUrl = ''
  const fetchImpl: FetchLike = (url, init) => {
    if (url.includes('/auth/')) throw new Error(`ATC must not authenticate — requested ${url}`)
    sentUrl = url
    if (init?.body !== undefined) sentBody = JSON.parse(init.body)
    return Promise.resolve({
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => body,
    })
  }
  return {fetchImpl, sent: () => sentBody, url: () => sentUrl}
}

describe('ATC is keyless', () => {
  it('reads the order book without minting or sending any credential', async () => {
    const {fetchImpl} = atcStub({orders: [{orderId: 'a#0', pair: ['lovelace', SNEK], status: 'OPEN'}]})
    const res = await run(fetchAtcOrders({limit: 1}, fetchImpl))
    expect(res._tag).toBe('Right')
  })
})

describe('parseAtcOrder', () => {
  it('keeps integer base units as exact strings', () => {
    const o = parseAtcOrder({
      orderId: 'a#0',
      pair: ['lovelace', SNEK],
      direction: 'buy',
      offer: {unit: 'lovelace', amount: 500_000_000},
      ask: {unit: SNEK, amount: 210_000},
      swapPrice: {numerator: 21, denominator: 50},
      status: 'OPEN',
      available: 500_000_000,
      ageSlots: 300,
    })
    expect(o?.offer).toEqual({unit: 'lovelace', amount: '500000000'})
    expect(o?.swapPrice).toEqual({numerator: '21', denominator: '50'})
  })

  it('drops a row with no order id rather than inventing one', () => {
    expect(parseAtcOrder({pair: []})).toBeNull()
  })
})

describe('buildAtcOrder', () => {
  it('sends integer amounts — the swap family type-carries-scale rule does NOT apply here', async () => {
    const {fetchImpl, sent} = atcStub({txCbor: '84a5', order: {pairBeacon: 'pb', beaconAddress: 'addr1'}})
    await run(
      buildAtcOrder(
        {
          ownerAddress: 'addr1q_base',
          offer: {unit: 'lovelace', amount: '500000000'},
          ask: {unit: SNEK, amount: '210000'},
          utxos: ['deadbeef'],
        },
        fetchImpl,
      ),
    )
    expect(sent().offer).toEqual({unit: 'lovelace', amount: 500_000_000})
    expect(sent().ask).toEqual({unit: SNEK, amount: 210_000})
    // `expiration` is documented as reserved and rejected if set.
    expect(sent()).not.toHaveProperty('expiration')
  })

  it('refuses an amount past a safe JSON integer instead of rounding it', async () => {
    // JSON.stringify would silently round past 2^53, and a rounded order amount
    // is a real order at the wrong size.
    const {fetchImpl} = atcStub({txCbor: '84a5'})
    const res = await run(
      buildAtcOrder(
        {
          ownerAddress: 'addr1q_base',
          offer: {unit: SNEK, amount: '90071992547409910'},
          ask: {unit: 'lovelace', amount: '1000000'},
          utxos: [],
        },
        fetchImpl,
      ),
    )
    expect(res._tag).toBe('Left')
    if (res._tag === 'Left') expect(res.left.reason).toContain('safe JSON integer')
  })
})

describe('buildAtcClose', () => {
  it('percent-encodes the # in the order id', async () => {
    const {fetchImpl, url} = atcStub({txCbor: '84close'})
    await run(buildAtcClose('abc#1', {ownerAddress: 'addr1q_base', utxos: []}, fetchImpl))
    expect(url()).toContain('abc%231')
    expect(url()).not.toContain('abc#1')
  })

  it('sends addWithdrawal only when asked — some wallets need it to attach the stake signature', async () => {
    const {fetchImpl, sent} = atcStub({txCbor: '84close'})
    await run(buildAtcClose('abc#1', {ownerAddress: 'addr1q_base', utxos: [], addWithdrawal: true}, fetchImpl))
    expect(sent().addWithdrawal).toBe(true)
  })

  it('fails when the response carries no txCbor rather than returning an empty tx', async () => {
    const {fetchImpl} = atcStub({})
    const res = await run(buildAtcClose('abc#1', {ownerAddress: 'addr1q_base', utxos: []}, fetchImpl))
    expect(res._tag).toBe('Left')
  })
})

describe('errors', () => {
  it('carries the flat machine code out of the body', async () => {
    const {fetchImpl} = atcStub(
      {error: 'unprocessable_content', message: 'offer and ask must be distinct assets'},
      {
        ok: false,
        status: 422,
      },
    )
    const res = await run(fetchAtcQuote('lovelace', '10000000', 'lovelace', fetchImpl))
    expect(res._tag).toBe('Left')
    if (res._tag === 'Left') {
      expect(res.left.code).toBe('unprocessable_content')
      expect(res.left.status).toBe(422)
    }
  })
})

describe('fetchAtcQuote', () => {
  it('keeps a large ageS as data, not an error — a QUIET pair is not stale', async () => {
    const {fetchImpl} = atcStub({
      offer: {unit: 'lovelace', amount: 10_000_000},
      ask: {unit: SNEK, amount: 5_000},
      referencePrice: '0.0005',
      price: '0.0005',
      priceSource: 'onchain',
      ageS: 86_400,
    })
    const res = await run(fetchAtcQuote('lovelace', '10000000', SNEK, fetchImpl))
    expect(res._tag).toBe('Right')
    if (res._tag === 'Right') {
      expect(res.right.ageS).toBe(86_400)
      expect(res.right.priceSource).toBe('onchain')
    }
  })
})
