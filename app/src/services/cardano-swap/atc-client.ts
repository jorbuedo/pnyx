/**
 * ATC — SteelSwap's on-chain **limit order** book (`/api/v2/atc/*`).
 *
 * A separate rail from the AMM aggregator, and it differs in four ways that
 * every caller has to respect:
 *
 * 1. **Keyless.** No credential at all — not the durable key, not a bearer.
 *    Verified live: `/api/v2/atc/orders` answers 200 unauthenticated. So these
 *    calls deliberately bypass `steelswapAuthedJson`, and must NOT be parked by
 *    the shared 429 backoff (there is no key here to throttle).
 * 2. **Ownership is the STAKING credential.** An order is owned by the stake
 *    part of the address it was placed with, and closing it requires that
 *    credential's signature. ⚠️ An enterprise address (`addr1v…`, no stake part)
 *    is rejected outright — it can neither place nor list orders.
 * 3. **Integer base units only.** The V2 swap family's "the JSON type carries
 *    the scale" convention does not apply. Amounts here are integers.
 * 4. **Its orders never appear in `/api/v2/orders`.** Two books, merged only in
 *    our own UI (`order-model.ts`).
 *
 * @module
 */

import {Effect} from 'effect'
import {logger} from '../../logger'
import {getCardanoAssetsConfig} from '../cardano-assets/config'
import {SteelswapError} from '../cardano-assets/steelswap'
import type {FetchLike} from '../cardano-assets/token-metadata'

const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>
const config = () => getCardanoAssetsConfig('mainnet')

/** An ATC amount: a unit and INTEGER base units. */
export type AtcAmount = {readonly unit: string; readonly amount: string}

/** The on-chain ask-per-offer limit, as the reduced rational it is written as. */
export type AtcPrice = {readonly numerator: string; readonly denominator: string}

export type AtcOrder = {
  /** `txHash#index` — the on-chain UTxO ref. */
  readonly orderId: string
  /** The market's two units, ADA (`lovelace`) first. */
  readonly pair: readonly string[]
  /** `sell` offers the token for ADA; `buy` offers ADA. */
  readonly direction: string
  readonly offer: AtcAmount
  readonly ask: AtcAmount
  readonly swapPrice: AtcPrice | null
  readonly ownerStake: string | null
  /** `OPEN` / `LIMIT` (resting), `FILLED`, `CANCELLED`. */
  readonly status: string
  /** Unfilled remainder of `offer`, in base units. */
  readonly available: string
  readonly ageSlots: number | null
}

export type AtcQuote = {
  readonly offer: AtcAmount
  readonly ask: AtcAmount
  readonly referencePrice: string
  readonly price: string
  readonly priceSource: 'coinbase' | 'onchain' | null
  readonly offsetBps: number | null
  readonly asOf: number | null
  /**
   * Seconds since the reference was read. ⚠️ NOT an error signal on its own — a
   * QUIET pair is not stale, so a large age still comes back as a 200.
   */
  readonly ageS: number | null
  readonly indexerLagS: number | null
  readonly insufficientDepth: boolean | null
  readonly filledOfferAmount: string | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const intStr = (v: unknown): string =>
  typeof v === 'number' ? Math.trunc(v).toString() : typeof v === 'string' ? v : '0'

const asAtcAmount = (v: unknown): AtcAmount => {
  const o = (v ?? {}) as {unit?: unknown; amount?: unknown}
  return {unit: typeof o.unit === 'string' ? o.unit : '', amount: intStr(o.amount)}
}

const asPrice = (v: unknown): AtcPrice | null => {
  if (v === null || typeof v !== 'object') return null
  const p = v as {numerator?: unknown; denominator?: unknown}
  if (p.numerator === undefined || p.denominator === undefined) return null
  return {numerator: intStr(p.numerator), denominator: intStr(p.denominator)}
}

/**
 * One keyless ATC request. Mirrors `steelswapAuthedJson`'s error handling — the
 * flat `{error, message}` body becomes the machine `code` — minus every part
 * that concerns a credential.
 */
const atcJson = (
  path: string,
  init: {method?: string; body?: string},
  fetchImpl: FetchLike,
): Effect.Effect<unknown, SteelswapError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(`${config().steelswapUrl}${path}`, {
          method: init.method ?? 'get',
          headers: {
            Accept: 'application/json',
            ...(init.body !== undefined ? {'Content-Type': 'application/json'} : {}),
          },
          ...(init.body !== undefined ? {body: init.body} : {}),
        }),
      catch: (e) => new SteelswapError({reason: e instanceof Error ? e.message : String(e)}),
    })
    if (!response.ok) {
      const errBody = yield* Effect.tryPromise({
        try: async () => (await response.json()) as unknown,
        catch: (e) => new SteelswapError({reason: e instanceof Error ? e.message : String(e)}),
      }).pipe(
        Effect.catchAll((e) => {
          // The status is still the fact we report; a non-JSON body is only
          // worth knowing about, not worth failing on.
          logger.debug('ATC error body was not JSON', {origin: 'atc-client', path, error: e.reason})
          return Effect.succeed(null)
        }),
      )
      const parsed = errBody !== null && typeof errBody === 'object' ? (errBody as Record<string, unknown>) : null
      const code = typeof parsed?.error === 'string' ? parsed.error : null
      return yield* Effect.fail(
        new SteelswapError({
          reason: `${path} ${response.status}${code === null ? '' : ` ${code}`}`,
          code,
          status: response.status,
          body: parsed,
        }),
      )
    }
    return yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (e) => new SteelswapError({reason: e instanceof Error ? e.message : String(e)}),
    })
  })

export const parseAtcOrder = (v: unknown): AtcOrder | null => {
  if (v === null || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const orderId = str(o.orderId)
  if (orderId === null) return null
  return {
    orderId,
    pair: Array.isArray(o.pair) ? o.pair.filter((p): p is string => typeof p === 'string') : [],
    direction: typeof o.direction === 'string' ? o.direction : '',
    offer: asAtcAmount(o.offer),
    ask: asAtcAmount(o.ask),
    swapPrice: asPrice(o.swapPrice),
    ownerStake: str(o.ownerStake),
    status: typeof o.status === 'string' ? o.status : 'unknown',
    available: intStr(o.available),
    ageSlots: num(o.ageSlots),
  }
}

/**
 * An owner's limit orders (full history), or — with no `owner` — the open book
 * across every owner.
 *
 * ⚠️ `limit` bounds the SQL read that happens BEFORE non-ADA-paired and
 * undecodable rows are dropped, so a short page does not mean the end of the
 * book.
 */
export const fetchAtcOrders = (
  query: {readonly owner?: string | null; readonly limit?: number},
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<readonly AtcOrder[], SteelswapError> => {
  const p: string[] = []
  if (query.owner != null && query.owner.length > 0) p.push(`owner=${encodeURIComponent(query.owner)}`)
  if (query.limit !== undefined) p.push(`limit=${query.limit}`)
  return atcJson(`/api/v2/atc/orders${p.length > 0 ? `?${p.join('&')}` : ''}`, {}, fetchImpl).pipe(
    Effect.map((body) => {
      const rows = (body as {orders?: unknown}).orders
      return (Array.isArray(rows) ? rows : []).map(parseAtcOrder).filter((o): o is AtcOrder => o !== null)
    }),
  )
}

/** One limit order by `txHash#index`. The `#` must be percent-encoded. */
export const fetchAtcOrder = (
  orderId: string,
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<AtcOrder, SteelswapError> =>
  atcJson(`/api/v2/atc/orders/${encodeURIComponent(orderId)}`, {}, fetchImpl).pipe(
    Effect.flatMap((body) => {
      const order = parseAtcOrder(body)
      return order === null
        ? Effect.fail(new SteelswapError({reason: `atc/orders/${orderId}: unreadable order`}))
        : Effect.succeed(order)
    }),
  )

/**
 * A recommended limit price for an ADA-paired market. One leg must be ADA, and
 * both legs need known decimals or this is a 422.
 */
export const fetchAtcQuote = (
  offerUnit: string,
  offerAmount: string,
  askUnit: string,
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<AtcQuote, SteelswapError> =>
  atcJson(
    `/api/v2/atc/quote?offerUnit=${encodeURIComponent(offerUnit)}&offerAmount=${encodeURIComponent(
      offerAmount,
    )}&askUnit=${encodeURIComponent(askUnit)}`,
    {},
    fetchImpl,
  ).pipe(
    Effect.map((body) => {
      const b = (body ?? {}) as Record<string, unknown>
      const src = b.priceSource
      return {
        offer: asAtcAmount(b.offer),
        ask: asAtcAmount(b.ask),
        referencePrice: intStr(b.referencePrice),
        price: intStr(b.price),
        priceSource: src === 'coinbase' || src === 'onchain' ? src : null,
        offsetBps: num(b.offsetBps),
        asOf: num(b.asOf),
        ageS: num(b.ageS),
        indexerLagS: num(b.indexerLagS),
        insufficientDepth: typeof b.insufficientDepth === 'boolean' ? b.insufficientDepth : null,
        filledOfferAmount: b.filledOfferAmount === undefined ? null : intStr(b.filledOfferAmount),
      }
    }),
  )

export type AtcBuilt = {
  readonly txCbor: string
  readonly pairBeacon: string | null
  readonly beaconAddress: string | null
}

/**
 * Build the unsigned CREATE that places a resting limit order.
 *
 * ⚠️ `ownerAddress` must carry a staking part — its staking credential becomes
 * the order's permanent owner identity and is required to sign a later close.
 * `expiration` is documented as reserved and rejected if set, so there is no
 * expiry parameter here.
 */
export const buildAtcOrder = (
  params: {
    readonly ownerAddress: string
    readonly offer: AtcAmount
    readonly ask: AtcAmount
    readonly utxos: readonly string[]
    readonly collateral?: readonly string[]
    readonly changeAddress?: string
  },
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<AtcBuilt, SteelswapError> =>
  Effect.gen(function* () {
    // The ATC schema types these as JSON integers, and JSON.stringify would
    // silently round anything past 2^53. Refusing is the only safe read: a
    // rounded order amount is a real order at the wrong size.
    for (const [side, a] of [
      ['offer', params.offer],
      ['ask', params.ask],
    ] as const) {
      if (!Number.isSafeInteger(Number(a.amount))) {
        return yield* Effect.fail(
          new SteelswapError({reason: `atc build: ${side} amount ${a.amount} exceeds a safe JSON integer`}),
        )
      }
    }
    return yield* buildAtcOrderUnchecked(params, fetchImpl)
  })

const buildAtcOrderUnchecked = (
  params: {
    readonly ownerAddress: string
    readonly offer: AtcAmount
    readonly ask: AtcAmount
    readonly utxos: readonly string[]
    readonly collateral?: readonly string[]
    readonly changeAddress?: string
  },
  fetchImpl: FetchLike,
): Effect.Effect<AtcBuilt, SteelswapError> =>
  atcJson(
    '/api/v2/atc/orders/build',
    {
      method: 'post',
      body: JSON.stringify({
        ownerAddress: params.ownerAddress,
        // The ATC schema is integer base units — not the {unit, amount} scale
        // convention the swap family uses.
        offer: {unit: params.offer.unit, amount: Number(params.offer.amount)},
        ask: {unit: params.ask.unit, amount: Number(params.ask.amount)},
        utxos: params.utxos,
        ...(params.collateral !== undefined ? {collateral: params.collateral} : {}),
        ...(params.changeAddress !== undefined ? {changeAddress: params.changeAddress} : {}),
      }),
    },
    fetchImpl,
  ).pipe(
    Effect.map((body) => {
      const b = (body ?? {}) as Record<string, unknown>
      const order = (b.order ?? {}) as Record<string, unknown>
      return {
        txCbor: typeof b.txCbor === 'string' ? b.txCbor : '',
        pairBeacon: str(order.pairBeacon),
        beaconAddress: str(order.beaconAddress),
      }
    }),
  )

/**
 * Build the unsigned CLOSE — collect a filled order's proceeds, or cancel a
 * resting one. Both are the same transaction shape.
 *
 * `addWithdrawal` adds a zero-lovelace reward withdrawal, which some wallets
 * need before they will attach the staking-credential signature the close
 * requires.
 */
export const buildAtcClose = (
  orderId: string,
  params: {
    readonly ownerAddress: string
    readonly utxos: readonly string[]
    readonly collateral?: readonly string[]
    readonly changeAddress?: string
    readonly addWithdrawal?: boolean
  },
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<string, SteelswapError> =>
  atcJson(
    `/api/v2/atc/orders/${encodeURIComponent(orderId)}/close/build`,
    {
      method: 'post',
      body: JSON.stringify({
        ownerAddress: params.ownerAddress,
        utxos: params.utxos,
        ...(params.collateral !== undefined ? {collateral: params.collateral} : {}),
        ...(params.changeAddress !== undefined ? {changeAddress: params.changeAddress} : {}),
        ...(params.addWithdrawal === true ? {addWithdrawal: true} : {}),
      }),
    },
    fetchImpl,
  ).pipe(
    Effect.flatMap((body) => {
      const cbor = ((body ?? {}) as {txCbor?: unknown}).txCbor
      return typeof cbor === 'string' && cbor.length > 0
        ? Effect.succeed(cbor)
        : Effect.fail(new SteelswapError({reason: `atc close ${orderId}: no txCbor`}))
    }),
  )
