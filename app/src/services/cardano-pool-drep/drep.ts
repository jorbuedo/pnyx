/**
 * DRep metadata resolution, two-tier and network-aware:
 *
 *  1. Our R2-backed active-DRep list (`dreps.json`, served R2-direct; MAINNET
 *     only) — the only source of a human `givenName` + verified image. The list
 *     is fetched once and cached (15 min), indexed by both bech32 and hex hash.
 *  2. Koios `drep_info` (all networks) — registration / activity / voting power /
 *     anchor, but no name.
 *
 * The two are merged: Koios owns the on-chain state, YBZ owns the name/image.
 * Unknown / unreachable on both tiers resolves to `null` (never a faked name);
 * abstain / no-confidence targets have no id and are not looked up by callers.
 *
 * @module
 */

import {Cip129} from '@evolution-sdk/cips'
import {Effect} from 'effect'
import {logger} from '../../logger'
import type {PoolDRepConfig} from './config'
import {bytesToHex, defaultFetch, type FetchLike, hexToBytes} from './http'
import {fetchSlowData} from './slow-data'

export type DRepInfo = {
  /** `drep1…` bech32 (CIP-129). */
  readonly id: string
  /** 28-byte DRep credential hash, hex. */
  readonly idHex: string
  readonly isScript: boolean
  readonly givenName?: string
  readonly imageUrl?: string
  readonly registered?: boolean
  readonly active?: boolean
  /** Delegated stake / voting power, lovelace. */
  readonly votingPower?: bigint
  readonly anchorUrl?: string
  readonly anchorHash?: string
}

const ACTIVE_TTL_MS = 15 * 60_000

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
const big = (v: unknown): bigint | undefined => {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v)
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v)
  return undefined
}
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/** `givenName` may be a bare string or a JSON-LD `{'@value': string}` wrapper. */
const unwrapValue = (v: unknown): string | undefined => {
  if (typeof v === 'string') return str(v)
  const rec = record(v)
  return str(rec['@value'])
}

/** One row of the picker's DRep list (system abstain / no-confidence rows are
 * synthesized by the UI, not part of this list). */
export type DRepListEntry = {
  /** `drep1…` bech32 (CIP-129). */
  readonly id: string
  /** 28-byte DRep credential hash, hex. */
  readonly idHex: string
  readonly isScript: boolean
  readonly givenName?: string
  readonly imageUrl?: string
  readonly votingPower?: bigint
  readonly delegators?: number
  readonly active?: boolean
}

// ── active-list index (15-min TTL, keyed by ybz base) ──
type YbzEntry = {
  readonly givenName?: string
  readonly imageUrl?: string
  readonly votingPower?: bigint
  readonly delegators?: number
  readonly anchorUrl?: string
  readonly anchorHash?: string
}
type ActiveIndex = ReadonlyMap<string, YbzEntry>
type ActiveList = {
  readonly index: ActiveIndex
  readonly entries: readonly DRepListEntry[]
}
/** Keyed on the register the list came from — see `listKey` in `pool.ts`. */
const activeKey = (config: PoolDRepConfig): string => config.dataUrl ?? `none:${config.network}`

const activeCache = new Map<string, {readonly at: number; readonly list: ActiveList}>()

/** Test seam: drop the cached active-DRep lists so a stubbed fetch is re-read. */
export const resetActiveDRepCache = (): void => {
  activeCache.clear()
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.length > 0 && Number.isFinite(Number(v))
      ? Number(v)
      : undefined

const parseActiveEntry = (
  raw: unknown,
): {readonly hex: string; readonly bech32: string; readonly isScript: boolean; readonly entry: YbzEntry} | null => {
  const e = record(raw)
  const hex = str(e.id)
  if (hex === undefined) return null
  const isScript = e.from === 'script'
  let bech32: string
  try {
    bech32 = Cip129.drepBech32(hexToBytes(hex), isScript)
  } catch (e: unknown) {
    // `null` drops the DRep from the list the user picks from, so one that cannot be encoded is
    // simply not offered.
    logger.warn('DRep id could not be encoded; the DRep is not listed', {origin: 'drep', error: String(e)})
    return null
  }
  const meta = record(e.metadata)
  const verified = e.metadataVerification === 'verified'
  const givenName = unwrapValue(meta.givenName)
  const imageUrl = verified ? str(record(meta.image).contentUrl) : undefined
  const votingPower = big(e.stake)
  const delegators = num(e.delegatorCount)
  const anchorUrl = str(e.anchorUrl)
  const anchorHash = str(e.anchorHash)
  const entry: YbzEntry = {
    ...(givenName !== undefined ? {givenName} : {}),
    ...(imageUrl !== undefined ? {imageUrl} : {}),
    ...(votingPower !== undefined ? {votingPower} : {}),
    ...(delegators !== undefined ? {delegators} : {}),
    ...(anchorUrl !== undefined ? {anchorUrl} : {}),
    ...(anchorHash !== undefined ? {anchorHash} : {}),
  }
  return {hex, bech32, isScript, entry}
}

/** Fetch + index the mainnet active-DRep list (bech32 + hex keys), TTL-cached. */
const fetchActiveList = (config: PoolDRepConfig, fetchImpl: FetchLike): Effect.Effect<ActiveList> =>
  Effect.gen(function* () {
    const cached = activeCache.get(activeKey(config))
    if (cached && Date.now() - cached.at < ACTIVE_TTL_MS) return cached.list

    const list = yield* Effect.tryPromise({
      try: async () => {
        const raw = await fetchSlowData(config.dataUrl, 'dreps', fetchImpl)
        const rows = (Array.isArray(raw) ? raw : []) as unknown[]
        const map = new Map<string, YbzEntry>()
        const entries: DRepListEntry[] = []
        for (const raw of Array.isArray(rows) ? rows : []) {
          const parsed = parseActiveEntry(raw)
          if (parsed === null) continue
          map.set(parsed.bech32, parsed.entry)
          map.set(parsed.hex, parsed.entry)
          entries.push({
            id: parsed.bech32,
            idHex: parsed.hex,
            isScript: parsed.isScript,
            ...(parsed.entry.givenName !== undefined ? {givenName: parsed.entry.givenName} : {}),
            ...(parsed.entry.imageUrl !== undefined ? {imageUrl: parsed.entry.imageUrl} : {}),
            ...(parsed.entry.votingPower !== undefined ? {votingPower: parsed.entry.votingPower} : {}),
            ...(parsed.entry.delegators !== undefined ? {delegators: parsed.entry.delegators} : {}),
          })
        }
        const fetched = {index: map as ActiveIndex, entries} satisfies ActiveList
        // Cache only successful reads — a transient outage must not pin an
        // empty list for the whole TTL.
        activeCache.set(activeKey(config), {at: Date.now(), list: fetched})
        return fetched
      },
      catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
    }).pipe(Effect.orElseSucceed((): ActiveList => ({index: new Map<string, YbzEntry>(), entries: []})))

    return list
  })

type KoiosRow = {
  readonly registered?: boolean
  readonly active?: boolean
  readonly votingPower?: bigint
  readonly anchorUrl?: string
  readonly anchorHash?: string
}

/** Koios `drep_info` for one id → the on-chain state fields (no name). */
const fetchKoios = (
  drepIdBech32: string,
  config: PoolDRepConfig,
  fetchImpl: FetchLike,
): Effect.Effect<KoiosRow | null> =>
  Effect.tryPromise({
    try: async () => {
      const r = await fetchImpl(`${config.koiosUrl}/drep_info`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Accept: 'application/json'},
        body: JSON.stringify({_drep_ids: [drepIdBech32]}),
      })
      if (!r.ok) throw new Error(`koios drep_info ${r.status}`)
      const rows = (await r.json()) as unknown[]
      const row = record(Array.isArray(rows) ? rows[0] : undefined)
      if (Object.keys(row).length === 0) return null
      const registered = bool(row.registered)
      const active = bool(row.active)
      const votingPower = big(row.amount)
      const anchorUrl = str(row.anchor_url)
      const anchorHash = str(row.anchor_hash)
      return {
        ...(registered !== undefined ? {registered} : {}),
        ...(active !== undefined ? {active} : {}),
        ...(votingPower !== undefined ? {votingPower} : {}),
        ...(anchorUrl !== undefined ? {anchorUrl} : {}),
        ...(anchorHash !== undefined ? {anchorHash} : {}),
      } satisfies KoiosRow
    },
    catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
  }).pipe(Effect.orElseSucceed(() => null))

/**
 * Resolve DRep metadata for a `drep1…` id. Merges the mainnet YBZ name/image
 * with Koios on-chain state. Returns `null` when the id is unparseable or
 * neither tier yields anything.
 */
export const fetchDRepInfo = (
  drepIdBech32: string,
  config: PoolDRepConfig,
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<DRepInfo | null> =>
  Effect.gen(function* () {
    const cred = Cip129.parseCredential(drepIdBech32)
    if (cred === undefined || cred.keyType !== 'drep') return null
    const idHex = bytesToHex(cred.hash)
    const isScript = cred.isScript

    // Gated on having a register, not on being on mainnet. A DRep id is a hash and
    // means the same thing everywhere; the old check meant a testnet never looked
    // one up at all, so a named DRep rendered as 56 characters of bech32 — the same
    // gap pools had. `dataUrl` is what actually decides whether there is anything
    // to consult.
    const ybz =
      config.dataUrl === undefined
        ? null
        : yield* fetchActiveList(config, fetchImpl).pipe(
            Effect.map(({index}) => index.get(drepIdBech32) ?? index.get(idHex) ?? null),
          )
    const koios = yield* fetchKoios(drepIdBech32, config, fetchImpl)

    if (ybz === null && koios === null) return null

    return {
      id: drepIdBech32,
      idHex,
      isScript,
      ...(ybz?.givenName !== undefined ? {givenName: ybz.givenName} : {}),
      ...(ybz?.imageUrl !== undefined ? {imageUrl: ybz.imageUrl} : {}),
      ...(koios?.registered !== undefined ? {registered: koios.registered} : {}),
      ...(koios?.active !== undefined ? {active: koios.active} : {}),
      ...(koios?.votingPower !== undefined
        ? {votingPower: koios.votingPower}
        : ybz?.votingPower !== undefined
          ? {votingPower: ybz.votingPower}
          : {}),
      ...(koios?.anchorUrl !== undefined
        ? {anchorUrl: koios.anchorUrl}
        : ybz?.anchorUrl !== undefined
          ? {anchorUrl: ybz.anchorUrl}
          : {}),
      ...(koios?.anchorHash !== undefined
        ? {anchorHash: koios.anchorHash}
        : ybz?.anchorHash !== undefined
          ? {anchorHash: ybz.anchorHash}
          : {}),
    }
  })

// ── picker list ──

const KOIOS_PAGE = 1000
const KOIOS_MAX_PAGES = 5

/** Koios `drep_list` rows (registered only) → bare list entries; one batched
 * `drep_info` enriches voting power + activity. Pages are bounded — beyond
 * `KOIOS_MAX_PAGES` the tail is dropped (testnet lists are far smaller). */
const fetchKoiosDRepList = (
  config: PoolDRepConfig,
  fetchImpl: FetchLike,
): Effect.Effect<readonly DRepListEntry[] | null> =>
  Effect.tryPromise({
    try: async () => {
      const bare: {id: string; hex: string; isScript: boolean}[] = []
      for (let page = 0; page < KOIOS_MAX_PAGES; page++) {
        const r = await fetchImpl(`${config.koiosUrl}/drep_list?offset=${page * KOIOS_PAGE}&limit=${KOIOS_PAGE}`, {
          headers: {Accept: 'application/json'},
        })
        if (!r.ok) throw new Error(`koios drep_list ${r.status}`)
        const rows = (await r.json()) as unknown[]
        if (!Array.isArray(rows)) break
        for (const raw of rows) {
          const row = record(raw)
          const id = str(row.drep_id)
          const hex = str(row.hex)
          if (id === undefined || hex === undefined || row.registered !== true) continue
          bare.push({id, hex, isScript: row.has_script === true})
        }
        if (rows.length < KOIOS_PAGE) break
      }
      if (bare.length === 0) return []

      const infoByIdRaw = new Map<string, Record<string, unknown>>()
      const ir = await fetchImpl(`${config.koiosUrl}/drep_info`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Accept: 'application/json'},
        body: JSON.stringify({_drep_ids: bare.map((d) => d.id)}),
      })
      if (ir.ok) {
        const rows = (await ir.json()) as unknown[]
        for (const raw of Array.isArray(rows) ? rows : []) {
          const row = record(raw)
          const id = str(row.drep_id)
          if (id !== undefined) infoByIdRaw.set(id, row)
        }
      }

      return bare.map(({id, hex, isScript}): DRepListEntry => {
        const info = infoByIdRaw.get(id)
        const votingPower = info !== undefined ? big(info.amount) : undefined
        const active = info !== undefined ? bool(info.active) : undefined
        return {
          id,
          idHex: hex,
          isScript,
          ...(votingPower !== undefined ? {votingPower} : {}),
          ...(active !== undefined ? {active} : {}),
        }
      })
    },
    catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
  }).pipe(Effect.orElseSucceed(() => null))

const koiosListCache = new Map<string, {readonly at: number; readonly entries: readonly DRepListEntry[]}>()

/** Test seam: drop the cached Koios DRep lists. */
export const resetKoiosDRepListCache = (): void => {
  koiosListCache.clear()
}

/**
 * Full DRep list for the picker. Mainnet uses the YBZ active list (names,
 * verified images); other networks fall back to Koios `drep_list` (bare ids +
 * voting power — testnet DReps have no name source). `null` = fetch failed
 * (picker shows an error state), `[]` = genuinely empty.
 */
export const fetchDRepList = (
  config: PoolDRepConfig,
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<readonly DRepListEntry[] | null> =>
  Effect.gen(function* () {
    if (config.network === 'mainnet') {
      const {entries} = yield* fetchActiveList(config, fetchImpl)
      // The mainnet active set is never genuinely empty (~1000 DReps) — an
      // empty read is an outage, surfaced as unavailable rather than "none".
      return entries.length > 0 ? entries : null
    }

    const cached = koiosListCache.get(config.koiosUrl)
    if (cached && Date.now() - cached.at < ACTIVE_TTL_MS) return cached.entries
    const entries = yield* fetchKoiosDRepList(config, fetchImpl)
    if (entries !== null) koiosListCache.set(config.koiosUrl, {at: Date.now(), entries})
    return entries
  })
