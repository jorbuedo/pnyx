/**
 * Token metadata resolution over SteelSwap (`POST /api/v2/tokens/metadata`).
 * Batches asset ids (converted to SteelSwap units), and degrades any id
 * SteelSwap doesn't resolve to a synthetic "unknown" info (UTF-8 asset name,
 * 0 decimals) rather than failing — a review must render even when the API is
 * down or a token is unlisted.
 *
 * @module
 */

import type {Network} from '@pnyx/wallet'
import {Data, Effect} from 'effect'
import {adaTickerFor} from '../../config/network-capabilities'
import {truncateCompact} from '../../utils/truncate'
import {assetFingerprint} from './asset-fingerprint'
import {ADA_ASSET_IDS, assetIdToUnit} from './asset-id'
import {cip68ClassOf, decodeAssetName, splitCip67Label} from './asset-name'
import type {CardanoAssetsConfig} from './config'
import {fetchMetadata, type SteelswapTokenMeta} from './steelswap'

/** ADA sentinels: empty id or the `.`-only id used by the value layer. */

export type TokenInfo = {
  /** `"policyHex.assetNameHex"`, or `''` for ADA. */
  readonly id: string
  /**
   * Decimal places, or `null` when NO source stated them.
   *
   * `null` is not `0`: plenty of tokens genuinely have zero decimals (HOSKY, SNEK)
   * and conflating the two silently mis-scales every quantity of an unresolved
   * token by orders of magnitude. Display renders `null` as the raw base-unit
   * count (see {@link displayDecimals}); value math refuses to price it at all.
   */
  readonly decimals: number | null
  readonly ticker?: string
  readonly name?: string
  readonly symbol?: string
  /** Best display label: ticker → name → symbol. Always present. */
  readonly label: string
  readonly isNft: boolean
  /**
   * The asset's own media URI, as the minter wrote it: `ipfs://…`, `https://…`
   * or an inline `data:` URI. Rendering an `ipfs://` one needs a gateway (see
   * `media.ts`); absent when the asset declares no media.
   */
  readonly image?: string
  /** IANA type the minter declared for `image`, when it declared one. */
  readonly mediaType?: string
  /** True when resolved from the registry; false for the synthetic fallback. */
  readonly known: boolean
  /** True when a real icon exists for this token (drives portfolio sorting +
   * lets a row skip the initials fallback). ADA is always true. */
  readonly hasIcon: boolean
}

export class TokenMetadataError extends Data.TaggedError('TokenMetadataError')<{
  readonly reason: string
}> {}

export const ADA_TOKEN_INFO: TokenInfo = {
  id: '',
  decimals: 6,
  ticker: 'ADA',
  symbol: 'ADA',
  label: 'ADA',
  isNft: false,
  known: true,
  hasIcon: true,
}

/**
 * ADA's info for a network — identical to {@link ADA_TOKEN_INFO} except the
 * ticker, which reads `tADA` on a testnet. Display code should prefer this;
 * `ADA_TOKEN_INFO` stays the canonical record for stored/serialized values,
 * where the ticker is a key rather than a label.
 */
export const adaTokenInfo = (network: Network): TokenInfo => {
  const ticker = adaTickerFor(network)
  return {...ADA_TOKEN_INFO, ticker, symbol: ticker, label: ticker}
}

const isAda = (id: string): boolean => ADA_ASSET_IDS.has(id)

/**
 * The scale to RENDER with when the true one is unknown: none. The number shown is
 * then the on-chain base-unit count, which is at least a true statement about the
 * ledger, rather than a decimal-shifted invention.
 */
export const displayDecimals = (decimals: number | null): number => decimals ?? 0

/**
 * Last-resort label for an asset whose name is not text: a short form of the
 * POLICY id, marked as one. Showing the first four bytes of the asset name (the
 * old behaviour) put a hex fragment where a name goes — and for a CIP-68 asset
 * that fragment was the label prefix, so unrelated tokens all read `0014df10`.
 */
/**
 * The last-resort label for an asset with no printable name.
 *
 * The CIP-14 fingerprint, not the policy id: a policy can mint many assets, so a
 * truncated policy labels them all identically — a real case is a Minswap pool
 * whose hash-named pool token and its `MSP` token share one policy, where both
 * would have read `f5808c2c…`. The fingerprint is unique per asset, is what every
 * explorer accepts, and is computed locally from the id.
 */
const namelessLabel = (id: string): string => {
  const fingerprint = assetFingerprint(id)
  if (fingerprint !== null) return truncateCompact(fingerprint)
  const policy = id.split('.')[0] ?? ''
  return policy.length > 0 ? truncateCompact(policy) : '(unnamed)'
}

/**
 * The unit to print *after* an amount of this token, or `undefined` when there is
 * nothing worth printing.
 *
 * A token with no ticker, no registry name and no on-chain asset name falls back to
 * its fingerprint as a {@link TokenInfo.label}. That fallback identifies the asset,
 * which is what the left-hand side of a row needs — but repeating it as the unit
 * renders `asset1cxcws8…vhl3g35s   1 asset1cxcws8…vhl3g35s`, saying the same thing
 * twice and burying the quantity. A fingerprint labels an asset; it never units an
 * amount.
 */
export const amountUnitFor = (info: TokenInfo): string | undefined => {
  if (info.ticker !== undefined && info.ticker !== '') return info.ticker
  if (info.name !== undefined && info.name !== '') return info.name
  // Only a *decoded on-chain name* makes the label a real unit; anything else is
  // the fingerprint (or policy) fallback.
  const assetNameHex = info.id.split('.')[1] ?? ''
  return decodeAssetName(assetNameHex) ?? undefined
}

/**
 * The best label we can derive locally: the decoded asset name (CIP-67 label
 * stripped), else a short policy id. No network, so this is also what an offline
 * or unlisted token shows.
 */
export const localAssetLabel = (id: string): string => {
  const assetNameHex = id.split('.')[1] ?? ''
  return decodeAssetName(assetNameHex) ?? namelessLabel(id)
}

/** Synthetic info for an id the registry didn't resolve (never fabricates a ticker). */
export const unknownTokenInfo = (id: string): TokenInfo => {
  if (isAda(id)) return ADA_TOKEN_INFO
  const assetNameHex = id.split('.')[1] ?? ''
  const decoded = decodeAssetName(assetNameHex)
  const label = decoded ?? namelessLabel(id)
  // A CIP-67 222 label means non-fungible by definition, so this is knowable
  // offline — no registry, no request. It keeps a price chart off an NFT.
  const cip67 = splitCip67Label(assetNameHex)
  const isNft = cip67 !== null && cip68ClassOf(cip67.label) === 'nft'
  // A decoded asset name is a NAME, not a ticker: it is what the minter called
  // the asset, and nothing about it says it is a trading symbol.
  return {
    id,
    // Nothing told us the scale. An NFT is indivisible so 0 is a fact there; for
    // anything else the honest answer is that we do not know.
    decimals: isNft ? 0 : null,
    ...(decoded !== null ? {name: decoded} : {}),
    label,
    isNft,
    known: false,
    hasIcon: false,
  }
}

const labelOf = (r: {
  ticker: string | undefined
  name: string | undefined
  symbol: string | undefined
  fallback: string
}): string =>
  r.ticker && r.ticker.length > 0
    ? r.ticker
    : r.name && r.name.length > 0
      ? r.name
      : r.symbol && r.symbol.length > 0
        ? r.symbol
        : r.fallback

/**
 * Build a `TokenInfo` from a resolved SteelSwap metadata row. SteelSwap lists
 * fungible DEX tokens only, so `isNft` is always false. An unknown `decimals`
 * stays `null` — the label is resolved, the scale simply is not, and pretending it
 * is 0 mis-scaled the quantity.
 */
const metaToInfo = (id: string, meta: SteelswapTokenMeta): TokenInfo => {
  const ticker = meta.ticker ?? undefined
  const name = meta.name ?? undefined
  const fallback = unknownTokenInfo(id).label
  return {
    id,
    decimals: meta.decimals ?? null,
    ...(ticker !== undefined ? {ticker} : {}),
    ...(name !== undefined ? {name} : {}),
    label: labelOf({ticker, name, symbol: undefined, fallback}),
    isNft: false,
    known: true,
    hasIcon: meta.hasIcon,
  }
}

/** Injectable fetch so tests never hit the network. */
export type FetchLike = (
  url: string,
  init?: {method?: string; headers?: Record<string, string>; body?: string},
) => Promise<{
  readonly ok: boolean
  readonly status: number
  readonly json: () => Promise<unknown>
  /** Response headers (present on the real `fetch`; optional so stubs can omit). */
  readonly headers?: {get(name: string): string | null}
}>

const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>

/**
 * Resolve infos for `ids`. ADA ids resolve locally; other ids convert to
 * SteelSwap units and batch to `POST /api/v2/tokens/metadata`. Ids SteelSwap
 * doesn't resolve (or a malformed id, or any transport/parse failure) degrade
 * to `unknownTokenInfo` — the returned map always covers every requested id.
 * `nowMs` is injected for the anon-key freshness check (defaults to now).
 */
export const fetchTokenInfos = (
  ids: readonly string[],
  config: CardanoAssetsConfig,
  fetchImpl: FetchLike = defaultFetch,
  nowMs: number = Date.now(),
): Effect.Effect<ReadonlyMap<string, TokenInfo>> =>
  Effect.gen(function* () {
    const out = new Map<string, TokenInfo>()
    const unitById = new Map<string, string>()
    for (const id of ids) {
      if (isAda(id)) {
        out.set(id, {...ADA_TOKEN_INFO, id})
        continue
      }
      if (out.has(id) || unitById.has(id)) continue
      const unit = assetIdToUnit(id)
      if (unit === null || unit.length === 0) out.set(id, unknownTokenInfo(id))
      else unitById.set(id, unit)
    }
    if (unitById.size === 0) return out

    const metaByUnit = yield* fetchMetadata([...unitById.values()], config, nowMs, fetchImpl).pipe(
      Effect.orElseSucceed(() => new Map<string, SteelswapTokenMeta>()),
    )
    for (const [id, unit] of unitById) {
      const meta = metaByUnit.get(unit)
      out.set(id, meta !== undefined ? metaToInfo(id, meta) : unknownTokenInfo(id))
    }
    return out
  })

// Re-exported where it has always been imported from; it is defined in `asset-id.ts`.
export {ADA_ASSET_IDS}
