/**
 * Koios `/asset_info` metadata fallback (CIP-26 token registry) for tokens
 * SteelSwap doesn't index. SteelSwap covers DEX-traded fungibles; a long-tail /
 * non-DEX token would otherwise degrade to `unknownTokenInfo` (0 decimals),
 * which mis-scales its quantity. Koios's on-chain registry supplies the real
 * `{name, ticker, decimals}` for registered assets; unregistered assets return
 * no `token_registry_metadata` and are simply absent from the result (the
 * caller keeps the unknown fallback — never a fabricated decimals value).
 *
 * @module
 */

import {Data, Effect} from 'effect'
import {logger} from '../../logger'
import {pacedKoiosFetch} from '../cardano/koios-request'
import {type FetchLike, type TokenInfo, unknownTokenInfo} from './token-metadata'

const ORIGIN = 'koios-metadata'

/** A Cardano policy id is 28 bytes = 56 hex chars. */
const POLICY_HEX_LEN = 56

/**
 * Koios's hard cap on a POST body, from its own refusal: *"Please ensure your request body size is
 * below 5120 bytes"*.
 *
 * ⚠️ **This used to be a count — 500 assets — and 500 assets is about 40 KB.** So every batch from a
 * wallet holding more than ~60 assets was refused with a 413 that the caller then swallowed (see
 * below), and those tokens silently kept `unknownTokenInfo`: no decimals, which *mis-scales the
 * quantity the user reads*. A count cannot bound a body whose entries vary in length; bytes can.
 */
/** Leaves room for the `{"_asset_list":[]}` wrapper and a margin under Koios's 5120-byte cap. */
const BODY_BUDGET_BYTES = 4_096

/**
 * Ask Koios for exactly the fields {@link parseKoiosRow} reads.
 *
 * ⚠️ **`token_registry_metadata` carries a base64 `logo`, and it dominates the response.** Measured on
 * a real mainnet wallet: 30 assets came back as 654 KB, of which 601 KB (92%) was logos — SNEK's alone
 * is 71 KB. Nothing here has ever used them: token icons come from the cexplorer image CDN
 * (`config.ts`), which serves a pre-sized WEBP. The same 30 assets with this projection are **14.7 KB**,
 * a 44× cut, because PostgREST flattens the three nested keys we actually read into columns.
 *
 * This is what a read-only mainnet wallet load was spending its memory on, and RN's dev-mode network
 * inspector then base64-encoded the body into a Java String and hit an OutOfMemoryError.
 */
const ASSET_INFO_SELECT =
  'select=policy_id,asset_name,total_supply,cip68_metadata,minting_tx_metadata,' +
  'token_registry_metadata->name,token_registry_metadata->ticker,token_registry_metadata->decimals'

/** Split `assets` so each request body stays inside {@link BODY_BUDGET_BYTES}. */
const chunkByBodyBytes = (assets: readonly [string, string][]): [string, string][][] => {
  const out: [string, string][][] = []
  let current: [string, string][] = []
  let bytes = 0
  for (const asset of assets) {
    // `["<56 hex>","<name hex>"],` as it will be serialised, which is what the cap measures.
    const cost = JSON.stringify(asset).length + 1
    if (current.length > 0 && bytes + cost > BODY_BUDGET_BYTES) {
      out.push(current)
      current = []
      bytes = 0
    }
    current.push(asset)
    bytes += cost
  }
  if (current.length > 0) out.push(current)
  return out
}

class KoiosMetadataError extends Data.TaggedError('KoiosMetadataError')<{readonly reason: string}> {}

// Paced and metered: these requests share Koios's budget with the rail's, so they
// share the client-side one too (see services/cardano/koios-request.ts).
const defaultFetch: FetchLike = (url, init) => pacedKoiosFetch(url, init) as unknown as ReturnType<FetchLike>

const num = (v: unknown): number | null => (typeof v === 'number' && v >= 0 ? v : null)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

/**
 * A CIP-68 datum field: `{bytes}` hex, `{int}`, or `{list}` of byte chunks (the
 * standard's answer to the 64-byte limit on a single byte string).
 */
type PlutusValue = {bytes?: unknown; int?: unknown; list?: unknown}

const hexToText = (hex: string): string | undefined => {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return undefined
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  try {
    const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes)
    return text.length > 0 ? text : undefined
  } catch (e: unknown) {
    logger.debug('Metadata bytes are not valid UTF-8', {origin: 'koios-metadata', error: String(e)})
    return undefined
  }
}

const plutusText = (v: PlutusValue | undefined): string | undefined => {
  if (v === undefined) return undefined
  if (typeof v.bytes === 'string') return hexToText(v.bytes)
  if (Array.isArray(v.list)) {
    const parts = v.list.map((c) => (typeof (c as PlutusValue)?.bytes === 'string' ? (c as {bytes: string}).bytes : ''))
    return hexToText(parts.join(''))
  }
  return undefined
}

const plutusInt = (v: PlutusValue | undefined): number | null =>
  v !== undefined && typeof v.int === 'number' && v.int >= 0 ? v.int : null

/**
 * CIP-68 on-chain metadata for an asset, from Koios's `cip68_metadata`. Shape is
 * `{ "<cip67 label>": { fields: [ { map: [{k,v}, …] }, … ] } }`, keys and string
 * values hex-encoded. This is the ONLY source of name/ticker/decimals for a
 * CIP-68 token that no off-chain registry lists — the minter put it in the datum.
 */
/** A CIP-25/CIP-68 URI may be split across array elements to dodge the 64-byte cap. */
const joinUri = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v.length > 0 ? v : undefined
  if (Array.isArray(v)) {
    const joined = v.filter((p): p is string => typeof p === 'string').join('')
    return joined.length > 0 ? joined : undefined
  }
  return undefined
}

/**
 * CIP-25 media, from the MINTING transaction's `721` metadata — the pre-CIP-68
 * NFT standard, and still the majority of Cardano NFTs. Shape is
 * `{"721": {"<policy>": {"<asset name>": {image, name, mediaType|mimeType, …}}}}`,
 * where the asset key is the name in ASCII for some minters and hex for others,
 * so both are tried before falling back to a single-entry collection.
 */
const parseCip25 = (
  raw: unknown,
  policyId: string,
  assetNameHex: string,
): {name?: string; image?: string; mediaType?: string} | null => {
  if (raw === null || typeof raw !== 'object') return null
  const seven21 = (raw as Record<string, unknown>)['721']
  if (seven21 === null || typeof seven21 !== 'object') return null
  const byPolicy = (seven21 as Record<string, unknown>)[policyId]
  if (byPolicy === null || typeof byPolicy !== 'object') return null
  const collection = byPolicy as Record<string, unknown>
  const ascii = hexToText(assetNameHex)
  const keys = Object.keys(collection)
  const key =
    (ascii !== undefined && ascii in collection ? ascii : undefined) ??
    (assetNameHex in collection ? assetNameHex : undefined) ??
    (keys.length === 1 ? keys[0] : undefined)
  if (key === undefined) return null
  const entry = collection[key]
  if (entry === null || typeof entry !== 'object') return null
  const e = entry as Record<string, unknown>
  const name = str(e.name)
  const image = joinUri(e.image)
  const mediaType = str(e.mediaType) ?? str(e.mimeType)
  if (name === undefined && image === undefined) return null
  return {
    ...(name !== undefined ? {name} : {}),
    ...(image !== undefined ? {image} : {}),
    ...(mediaType !== undefined ? {mediaType} : {}),
  }
}

const parseCip68 = (
  raw: unknown,
): {
  name?: string
  ticker?: string
  decimals: number | null
  image?: string
  mediaType?: string
  isNft: boolean
} | null => {
  if (raw === null || typeof raw !== 'object') return null
  const byLabel = raw as Record<string, unknown>
  for (const label of ['333', '444', '222', '100']) {
    const entry = byLabel[label]
    if (entry === null || typeof entry !== 'object') continue
    const fields = (entry as {fields?: unknown}).fields
    if (!Array.isArray(fields)) continue
    const first = fields[0] as {map?: unknown} | undefined
    if (!Array.isArray(first?.map)) continue
    const values = new Map<string, PlutusValue>()
    for (const pair of first.map) {
      const p = pair as {k?: PlutusValue; v?: PlutusValue}
      const key = typeof p.k?.bytes === 'string' ? hexToText(p.k.bytes) : undefined
      if (key !== undefined && p.v !== undefined) values.set(key, p.v)
    }
    const name = plutusText(values.get('name'))
    const ticker = plutusText(values.get('ticker'))
    const decimals = plutusInt(values.get('decimals'))
    const image = plutusText(values.get('image'))
    const mediaType = plutusText(values.get('mediaType'))
    if (name === undefined && ticker === undefined && decimals === null && image === undefined) continue
    return {
      ...(name !== undefined ? {name} : {}),
      ...(ticker !== undefined ? {ticker} : {}),
      ...(image !== undefined ? {image} : {}),
      ...(mediaType !== undefined ? {mediaType} : {}),
      // A CIP-68 NFT (222) has no decimals field and is indivisible.
      decimals: decimals ?? (label === '222' ? 0 : null),
      isNft: label === '222',
    }
  }
  return null
}

/**
 * Build a `TokenInfo` from a Koios `/asset_info` row, or `null` when the row
 * carries nothing worth overriding the local fallback with.
 *
 * Two sources, in order: the CIP-26 off-chain registry, then the asset's own
 * CIP-68 datum. The registry wins because it is curated, but most CIP-68 tokens
 * are not in it — and reading only the registry (the original behaviour) threw
 * away a datum that already stated the name, ticker and decimals, in a response
 * we had already paid for.
 */
const parseKoiosRow = (row: unknown): TokenInfo | null => {
  if (row === null || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  const policy = str(r.policy_id)
  const name = typeof r.asset_name === 'string' ? r.asset_name : ''
  if (policy === undefined) return null
  const id = `${policy}.${name}`

  // The projection above flattens the registry's three keys to columns; a caller that asked for the
  // whole object (or a fixture written that way) still works, so this reads either shape.
  const reg = r.token_registry_metadata
  const nested = reg !== null && typeof reg === 'object' ? (reg as Record<string, unknown>) : null
  const rec: Record<string, unknown> | null =
    nested ?? (r.name !== undefined || r.ticker !== undefined || r.decimals !== undefined ? r : null)
  const cip68 = parseCip68(r.cip68_metadata)
  const cip25 = parseCip25(r.minting_tx_metadata, policy, name)

  const decimals = num(rec?.decimals) ?? cip68?.decimals ?? null
  const ticker = str(rec?.ticker) ?? cip68?.ticker
  const nameField = str(rec?.name) ?? cip68?.name ?? cip25?.name
  const image = cip68?.image ?? cip25?.image
  const mediaType = cip68?.mediaType ?? cip25?.mediaType
  if (decimals === null && ticker === undefined && nameField === undefined && image === undefined) return null

  // Uniqueness is a SUPPLY fact, not a metadata fact: plenty of fungibles carry
  // CIP-25 `721` metadata (CAST has 1.5 billion of them) and plenty of collectibles
  // are not one-of-one (a Cardania founder card has 2500). So: a total supply of
  // one, or a CIP-68 222 which says so outright.
  const isNft = cip68?.isNft === true || str(r.total_supply) === '1'

  return {
    id,
    // An NFT is indivisible (0 is a fact); a fungible nobody documented keeps its
    // scale unknown rather than being mis-scaled as whole units.
    decimals: decimals ?? (isNft ? 0 : null),
    ...(ticker !== undefined ? {ticker} : {}),
    ...(nameField !== undefined ? {name: nameField} : {}),
    ...(image !== undefined ? {image} : {}),
    ...(mediaType !== undefined ? {mediaType} : {}),
    label: ticker ?? nameField ?? unknownTokenInfo(id).label,
    isNft,
    known: true,
    // ⚠️ **"The registry knows this token", not "the registry has a logo".** It used to be the latter,
    // which required downloading every logo to answer. Nothing renders this field — the icon URL is
    // built from the asset id unconditionally and served by the CDN — so the weaker signal costs
    // nothing, and a future consumer that needs true logo presence should ask the CDN, not Koios.
    hasIcon: rec !== null,
  }
}

/**
 * Resolve registry metadata for `ids` (app `"policyHex.assetNameHex"`) via Koios
 * `POST /asset_info`. Returns only the ids Koios's registry knows; on any
 * transport/parse failure the map is empty (best-effort fallback, never throws).
 */
export const fetchKoiosTokenInfos = (
  ids: readonly string[],
  koiosUrl: string,
  koiosToken: string | undefined,
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<ReadonlyMap<string, TokenInfo>> =>
  Effect.gen(function* () {
    const out = new Map<string, TokenInfo>()
    const assetList: Array<[string, string]> = []
    for (const id of ids) {
      const dot = id.indexOf('.')
      if (dot !== POLICY_HEX_LEN) continue
      assetList.push([id.slice(0, dot), id.slice(dot + 1)])
    }
    if (assetList.length === 0) return out

    for (const batch of chunkByBodyBytes(assetList)) {
      const rows = yield* Effect.tryPromise({
        try: async () => {
          const r = await fetchImpl(`${koiosUrl}/asset_info?${ASSET_INFO_SELECT}`, {
            method: 'post',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              ...(koiosToken !== undefined ? {authorization: `Bearer ${koiosToken}`} : {}),
            },
            body: JSON.stringify({_asset_list: batch}),
          })
          if (!r.ok) throw new Error(`asset_info ${r.status}`)
          return (await r.json()) as unknown
        },
        catch: (e) => new KoiosMetadataError({reason: e instanceof Error ? e.message : String(e)}),
      }).pipe(
        // ⚠️ **The empty fallback is right and the silence was not.** "Koios does not know these
        // assets" and "the request was refused" produce the same empty map, and the second one leaves
        // every token in the batch with unknown decimals — a wrong number on screen, from a cause
        // nobody could see. The 413 above went unnoticed for exactly this reason.
        Effect.catchAll((error) => {
          logger.warn('koios asset metadata could not be read; those tokens keep their unknown scale', {
            origin: ORIGIN,
            assets: batch.length,
            reason: error.reason,
          })
          return Effect.succeed([] as unknown[])
        }),
      )

      if (!Array.isArray(rows)) continue
      for (const row of rows) {
        const info = parseKoiosRow(row)
        if (info !== null) out.set(info.id, info)
      }
    }
    return out
  })
