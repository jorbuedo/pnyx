import {Effect} from 'effect'
import {beforeEach, describe, expect, it} from 'vitest'
import {resetSteelswapAuth, setSteelswapSigner} from '../cardano-assets/steelswap-auth'
import type {FetchLike} from '../cardano-assets/token-metadata'
import {quoteChangedEstimate, steelswapV2} from './provider-v2'
import {assetIdToSwapUnit, swapUnitToAssetId} from './swap-asset'

const POLICY = 'a'.repeat(56)
const SNEK = `${POLICY}534e454b`

describe('swap-asset', () => {
  it('maps ADA to the "lovelace" swap unit', () => {
    expect(assetIdToSwapUnit('')).toBe('lovelace')
    expect(assetIdToSwapUnit('.')).toBe('lovelace')
  })
  it('maps a token to its concatenated unit', () => {
    expect(assetIdToSwapUnit(`${POLICY}.534e454b`)).toBe(SNEK)
  })
  it('reverses lovelace → ADA and rejects malformed', () => {
    expect(swapUnitToAssetId('lovelace')).toBe('')
    expect(assetIdToSwapUnit('nodot')).toBeNull()
  })
})

/** Serve the CIP-8 mint chain, since there is no anonymous key any more. */
const authRoute = (url: string): Promise<{ok: boolean; status: number; json: () => Promise<unknown>}> | null => {
  if (url.includes('/auth/cip8/challenge'))
    return Promise.resolve({ok: true, status: 200, json: async () => ({challenge: {}, message: 'm'})})
  if (url.includes('/auth/cip8/verify'))
    return Promise.resolve({ok: true, status: 200, json: async () => ({access_token: 'jwt', expires_in: 900})})
  if (url.includes('/api/v2/auth/keys'))
    return Promise.resolve({ok: true, status: 201, json: async () => ({api_key: 'k', prefix: 'pf'})})
  return null
}

/** v2 stub: mints the durable key, then serves keyed routes. */
const stubV2 =
  (routes: Record<string, unknown>, status = 404): FetchLike =>
  (url) => {
    const auth = authRoute(url)
    if (auth !== null) return auth
    const key = Object.keys(routes).find((k) => url.includes(k))
    return Promise.resolve({
      ok: key !== undefined,
      status: key !== undefined ? 200 : status,
      json: async () => routes[key ?? ''] ?? {},
    })
  }

beforeEach(() => {
  resetSteelswapAuth()
  setSteelswapSigner({
    addressBech32: 'addr1_test',
    sign: async () => ({signature: 'sig', key: 'key'}),
  })
})

describe('steelswapV2 adapter (cicdapi /api/v2)', () => {
  it('parses the estimate response (amounts, fees, split kind)', async () => {
    const impl = stubV2({
      '/api/v2/swap/estimate': {
        input: {unit: 'lovelace', amount: '100000000'},
        output: {unit: SNEK, amount: '53559'},
        effectivePrice: 0.00188,
        fees: {
          batcher: {unit: 'lovelace', amount: '850000'},
          deposit: {unit: 'lovelace', amount: '3150000'},
          service: {unit: 'lovelace', amount: '0'},
        },
        split: [{kind: 'ammSwap', dex: 'WingRiders', poolId: 'abc', batcherFee: {unit: 'lovelace', amount: '850000'}}],
      },
    })
    const est = await Effect.runPromise(
      steelswapV2.fetchEstimate(
        {kind: 'exactIn', inputUnit: 'lovelace', amount: '100000000', outputUnit: SNEK},
        1_000,
        {},
        impl,
      ),
    )
    expect(est.output).toEqual({unit: SNEK, amount: '53559'})
    expect(est.fees.batcher.amount).toBe('850000')
    expect(est.split[0]).toMatchObject({kind: 'ammSwap', dex: 'WingRiders'})
  })

  it('fails with SteelswapError on no_route (404)', async () => {
    const res = await Effect.runPromise(
      Effect.either(
        steelswapV2.fetchEstimate(
          {kind: 'exactIn', inputUnit: 'lovelace', amount: '1', outputUnit: SNEK},
          1_000,
          {},
          stubV2({}),
        ),
      ),
    )
    expect(res._tag).toBe('Left')
  })

  it('build sends v2 params and returns txCbor + partialSign', async () => {
    let sentBody: Record<string, unknown> = {}
    const impl: FetchLike = (url, init) => {
      const auth = authRoute(url)
      if (auth !== null) return auth
      if (url.includes('/api/v2/swap/build')) {
        sentBody = JSON.parse((init?.body ?? '{}') as string)
        return Promise.resolve({ok: true, status: 200, json: async () => ({txCbor: '84a500', partialSign: true})})
      }
      return Promise.resolve({ok: false, status: 404, json: async () => ({})})
    }
    const built = await Effect.runPromise(
      steelswapV2.buildSwap(
        {
          side: {kind: 'exactIn', inputUnit: 'lovelace', amount: '100000000', outputUnit: SNEK},
          expectedOutput: {unit: SNEK, amount: '53559'},
          slippageBps: 100,
          addressSource: 'addr1xyz',
          utxos: ['deadbeef'],
        },
        1_000,
        impl,
      ),
    )
    expect(built).toMatchObject({txCbor: '84a500', partialSign: true})
    expect(sentBody).toMatchObject({slippageBps: 100, babelFee: 'ifNeeded', utxos: ['deadbeef'], ttlSeconds: 600})
  })

  it('parses order + cancel + batcher rows', async () => {
    const order = await Effect.runPromise(
      steelswapV2.fetchOrder(
        'abc',
        1_000,
        stubV2({
          '/api/v2/orders/abc': {
            txHash: 'abc',
            status: 'complete',
            orderType: 'ammSwap',
            received: [{unit: SNEK, amount: '53559'}],
            remaining: [],
            fillReason: 'filled',
          },
        }),
      ),
    )
    expect(order).toMatchObject({status: 'complete', fillReason: 'filled'})
    const txs = await Effect.runPromise(
      steelswapV2.cancelSwap(
        [{txHash: 'abc', txIndex: 0}],
        'addr1xyz',
        undefined,
        1_000,
        stubV2({
          '/api/v2/swap/cancel': {
            transactions: [
              {txCbor: '84a5', partialSign: false, plutusVersion: 'v2v3', cancelledRefs: [{txHash: 'abc', txIndex: 0}]},
            ],
          },
        }),
      ),
    )
    expect(txs.transactions[0]).toMatchObject({txCbor: '84a5', partialSign: false, plutusVersion: 'v2v3'})
    expect(txs.skipped).toEqual([])
    const rows = await Effect.runPromise(
      steelswapV2.fetchBatcherStatus(
        1_000,
        stubV2({
          // Shape copied from the live response (2026-07-26).
          '/api/v2/batcher/status': {
            currentSlot: 193_528_930,
            protocols: [
              {
                protocol: 'Minswap',
                status: 'QUIET',
                lastClearedSlot: 193_528_925,
                lastClearedAt: 1_785_095_216_000,
                demandCount: 0,
                warnThresholdBlocks: 3,
                downThresholdBlocks: 10,
              },
            ],
          },
        }),
      ),
    )
    expect(rows[0]).toMatchObject({
      protocol: 'Minswap',
      status: 'QUIET',
      lastClearedSlot: 193_528_925,
      demandCount: 0,
      warnThresholdBlocks: 3,
      downThresholdBlocks: 10,
    })
  })
})

describe('cancel partitioning', () => {
  it('reports an all-skipped batch as a 200 with no transactions, not an error', async () => {
    // The API answers 200 with `transactions: []` when nothing was cancellable.
    // A caller that only handles the failure path renders nothing at all.
    const res = await Effect.runPromise(
      steelswapV2.cancelSwap(
        [
          {txHash: 'a', txIndex: 0},
          {txHash: 'b', txIndex: 1},
        ],
        'addr1xyz',
        undefined,
        1_000,
        stubV2({
          '/api/v2/swap/cancel': {
            transactions: [],
            skipped: [
              {txHash: 'a', txIndex: 0, reason: 'already_executed'},
              {txHash: 'b', txIndex: 1, reason: 'axo'},
            ],
          },
        }),
      ),
    )
    expect(res.transactions).toEqual([])
    expect(res.skipped.map((s) => s.reason)).toEqual(['already_executed', 'axo'])
  })

  it('keeps refundSkipped separate from skipped — the order WAS cancelled', async () => {
    const res = await Effect.runPromise(
      steelswapV2.cancelSwap(
        [{txHash: 'a', txIndex: 0}],
        'addr1xyz',
        undefined,
        1_000,
        stubV2({
          '/api/v2/swap/cancel': {
            transactions: [{txCbor: '84', partialSign: false, plutusVersion: 'v1', cancelledRefs: []}],
            refundSkipped: [{txHash: 'a', txIndex: 0, reason: 'fee_utxo_unavailable'}],
          },
        }),
      ),
    )
    expect(res.skipped).toEqual([])
    expect(res.refundSkipped[0]).toMatchObject({reason: 'fee_utxo_unavailable'})
  })

  it('returns one transaction per Plutus-version bucket', async () => {
    const res = await Effect.runPromise(
      steelswapV2.cancelSwap(
        [
          {txHash: 'a', txIndex: 0},
          {txHash: 'b', txIndex: 0},
        ],
        'addr1xyz',
        undefined,
        1_000,
        stubV2({
          '/api/v2/swap/cancel': {
            transactions: [
              {txCbor: '84v1', partialSign: false, plutusVersion: 'v1', cancelledRefs: [{txHash: 'a', txIndex: 0}]},
              {txCbor: '84v2', partialSign: true, plutusVersion: 'v2v3', cancelledRefs: [{txHash: 'b', txIndex: 0}]},
            ],
          },
        }),
      ),
    )
    expect(res.transactions.map((t) => t.plutusVersion)).toEqual(['v1', 'v2v3'])
    expect(res.transactions[1]?.cancelledRefs).toEqual([{txHash: 'b', txIndex: 0}])
  })
})

describe('quote_changed', () => {
  it('carries the fresh quote out of the 409 body instead of failing opaquely', async () => {
    const fresh = {
      input: {unit: 'lovelace', amount: '100000000'},
      output: {unit: SNEK, amount: '51000'},
      effectivePrice: 0.00196,
      fees: {
        batcher: {unit: 'lovelace', amount: '850000'},
        deposit: {unit: 'lovelace', amount: '3150000'},
        service: {unit: 'lovelace', amount: '0'},
      },
      split: [],
    }
    const impl: FetchLike = (url) => {
      const auth = authRoute(url)
      if (auth !== null) return auth
      return Promise.resolve({
        ok: false,
        status: 409,
        json: async () => ({error: 'quote_changed', message: 'the quote moved', quote: fresh}),
      })
    }
    const res = await Effect.runPromise(
      Effect.either(
        steelswapV2.buildSwap(
          {
            side: {kind: 'exactIn', inputUnit: 'lovelace', amount: '100000000', outputUnit: SNEK},
            expectedOutput: {unit: SNEK, amount: '53559'},
            slippageBps: 100,
            addressSource: 'addr1xyz',
          },
          1_000,
          impl,
        ),
      ),
    )
    expect(res._tag).toBe('Left')
    if (res._tag !== 'Left') return
    expect(res.left.code).toBe('quote_changed')
    // The caller shows the delta and asks again — it must never rebuild silently.
    expect(quoteChangedEstimate(res.left)?.output.amount).toBe('51000')
  })
})

describe('swap/notify', () => {
  it('posts the hash and the signed CBOR, and treats 204 as success', async () => {
    let sent: Record<string, unknown> = {}
    const impl: FetchLike = (url, init) => {
      const auth = authRoute(url)
      if (auth !== null) return auth
      sent = JSON.parse((init?.body ?? '{}') as string)
      return Promise.resolve({ok: true, status: 204, json: async () => null})
    }
    await Effect.runPromise(steelswapV2.notifySwap('hash1', '84signed', 1_000, impl))
    expect(sent).toEqual({txHash: 'hash1', txCbor: '84signed'})
  })
})
