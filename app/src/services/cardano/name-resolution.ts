/**
 * Recipient resolution: a bech32 address (validated against the wallet's
 * network), an ADA Handle (`$name`, via the rail's Koios `asset_nft_address`),
 * or a CNS name (`name.ada`, via the hosted CNS resolver). Never fabricates an
 * address — an unresolvable / expired name is a typed error.
 *
 * @module
 */

import {Bech32} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {Data, Effect} from 'effect'
import {routeRecipient} from '../send/recipient-rail'
import {ADA_HANDLE_POLICY, CNS_CONFIG} from './config'
import {koiosAuthHeaders, pacedKoiosFetch} from './koios-request'
import type {CardanoRail} from './rail'

export class NameResolutionError extends Data.TaggedError('NameResolutionError')<{
  readonly kind:
    | 'invalid-address'
    | 'wrong-network'
    /** A well-formed Midnight address. Not a Cardano recipient, and not a mistake by the user. */
    | 'midnight-address'
    /** `mn_dust…` — where generated DUST is delivered, never a payment destination. */
    | 'midnight-dust-address'
    /** An `mn_` address whose checksum failed, or a type this build does not know. */
    | 'midnight-damaged'
    | 'handle-not-found'
    | 'handle-unavailable'
    | 'cns-not-found'
    | 'cns-expired'
    | 'cns-unavailable'
    | 'lookup-failed'
  readonly reason: string
}> {}

export type ResolvedRecipient = {
  readonly addressHex: string
  /** The `$handle` / `name.ada` when the input was a name, else null. */
  readonly name: string | null
}

const HANDLE_RE = /^\$?[a-z0-9._-]{1,64}$/

// ── resolved-name cache ───────────────────────────────────────────────────────
// A live recipient field resolves on every edit; cache to avoid hammering Koios
// / CNS. Positives are stable for ~1 h; only *definitive* negatives (the name
// genuinely doesn't resolve) are cached, and only briefly, so a freshly
// registered name isn't stuck. Transient / config failures are never cached.
const NAME_CACHE_POSITIVE_TTL_MS = 60 * 60_000
const NAME_CACHE_NEGATIVE_TTL_MS = 5 * 60_000

type NameCacheEntry =
  | {readonly kind: 'ok'; readonly value: ResolvedRecipient; readonly at: number}
  | {readonly kind: 'err'; readonly error: NameResolutionError; readonly at: number}

const nameCache = new Map<string, NameCacheEntry>()

/** Definitive "does not resolve" outcomes — safe to cache briefly. Transient
 * (`lookup-failed`) and config (`*-unavailable`) failures are not cached. */
export const CACHEABLE_NAME_ERROR_KINDS: ReadonlySet<NameResolutionError['kind']> = new Set([
  'handle-not-found',
  'cns-not-found',
  'cns-expired',
])

/** Whether a cache entry is still within its kind-dependent TTL. */
export const nameCacheEntryFresh = (
  entry: {readonly kind: 'ok' | 'err'; readonly at: number},
  nowMs: number,
): boolean => nowMs - entry.at < (entry.kind === 'ok' ? NAME_CACHE_POSITIVE_TTL_MS : NAME_CACHE_NEGATIVE_TTL_MS)

/** Wrap a name→address resolution with the cache: serve a fresh hit, else run
 * `eff`, caching the success (or a definitive negative). */
const withNameCache = (
  key: string,
  eff: Effect.Effect<ResolvedRecipient, NameResolutionError>,
): Effect.Effect<ResolvedRecipient, NameResolutionError> =>
  Effect.suspend(() => {
    const hit = nameCache.get(key)
    if (hit !== undefined && nameCacheEntryFresh(hit, Date.now())) {
      return hit.kind === 'ok' ? Effect.succeed(hit.value) : Effect.fail(hit.error)
    }
    return eff.pipe(
      Effect.tap((value) => Effect.sync(() => nameCache.set(key, {kind: 'ok', value, at: Date.now()}))),
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (CACHEABLE_NAME_ERROR_KINDS.has(error.kind)) nameCache.set(key, {kind: 'err', error, at: Date.now()})
        }),
      ),
    )
  })

/** Clear the resolved-name cache (tests). */
export const clearNameCache = (): void => {
  nameCache.clear()
}

const toHex = (s: string): string => {
  const bytes = new TextEncoder().encode(s)
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** Validate a bech32 address for the rail's network → raw hex. */
const resolveAddress = (input: string, rail: CardanoRail): Effect.Effect<ResolvedRecipient, NameResolutionError> =>
  Effect.try({
    try: () => {
      const hex = Address.fromBech32Sync(Bech32(input))
      const info = Address.inspect(hex)
      if (info.kind === Address.AddressKind.Byron) throw new Error('byron addresses are not supported')
      if (info.networkId !== rail.config.networkId) throw new Error('address is for a different network')
      return hex
    },
    catch: (e) =>
      new NameResolutionError({
        kind: (e as Error).message.includes('network') ? 'wrong-network' : 'invalid-address',
        reason: (e as Error).message,
      }),
  }).pipe(Effect.map((addressHex) => ({addressHex, name: null})))

/** Resolve an ADA Handle to its holder's address via Koios `asset_nft_address`. */
const resolveHandle = (handle: string, rail: CardanoRail): Effect.Effect<ResolvedRecipient, NameResolutionError> =>
  Effect.gen(function* () {
    const policy = ADA_HANDLE_POLICY[rail.config.network]
    if (policy === null) {
      return yield* Effect.fail(
        new NameResolutionError({kind: 'handle-unavailable', reason: `no ADA Handle policy on ${rail.config.network}`}),
      )
    }
    const name = handle.replace(/^\$/, '')
    return yield* withNameCache(
      `${rail.config.network}:$${name}`,
      Effect.gen(function* () {
        const bech32 = yield* Effect.tryPromise({
          try: async () => {
            const res = await pacedKoiosFetch(`${rail.config.koiosUrl}/asset_nft_address`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...koiosAuthHeaders(rail.config.network, rail.config.koiosUrl),
              },
              body: JSON.stringify({_asset_policy: policy, _asset_name: toHex(name)}),
            })
            if (!res.ok) throw new Error(`koios ${res.status}`)
            const rows = (await res.json()) as ReadonlyArray<{payment_address?: string}>
            return rows[0]?.payment_address ?? null
          },
          catch: (e) =>
            new NameResolutionError({kind: 'lookup-failed', reason: e instanceof Error ? e.message : String(e)}),
        })
        if (bech32 === null) {
          return yield* Effect.fail(new NameResolutionError({kind: 'handle-not-found', reason: `$${name} is unminted`}))
        }
        const resolved = yield* resolveAddress(bech32, rail)
        return {addressHex: resolved.addressHex, name: `$${name}`}
      }),
    )
  })

/** Resolve a CNS name (`name.ada`) to its address via the hosted CNS resolver. */
const resolveCns = (input: string, rail: CardanoRail): Effect.Effect<ResolvedRecipient, NameResolutionError> =>
  Effect.gen(function* () {
    const cns = CNS_CONFIG[rail.config.network]
    if (cns === null) {
      return yield* Effect.fail(
        new NameResolutionError({kind: 'cns-unavailable', reason: `CNS is not available on ${rail.config.network}`}),
      )
    }
    const domain = input.toLowerCase()
    return yield* withNameCache(
      `${rail.config.network}:${domain}`,
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
          try: async () => {
            const res = await fetch(cns.url, {
              method: 'POST',
              headers: {accept: 'application/json', 'content-type': 'application/json'},
              body: JSON.stringify({domain, cnsPolicyId: cns.cnsPolicyId, cnsRecordPolicyId: cns.cnsRecordPolicyId}),
            })
            if (!res.ok) throw new Error(`cns ${res.status}`)
            return (await res.json()) as {address?: string | null; expired?: boolean}
          },
          catch: (e) =>
            new NameResolutionError({kind: 'lookup-failed', reason: e instanceof Error ? e.message : String(e)}),
        })
        if (result.expired === true) {
          return yield* Effect.fail(new NameResolutionError({kind: 'cns-expired', reason: `${domain} is expired`}))
        }
        if (result.address === undefined || result.address === null || result.address.length === 0) {
          return yield* Effect.fail(
            new NameResolutionError({kind: 'cns-not-found', reason: `${domain} is unregistered`}),
          )
        }
        const resolved = yield* resolveAddress(result.address, rail)
        return {addressHex: resolved.addressHex, name: domain}
      }),
    )
  })

/**
 * Resolve a recipient input: `addr…`/`addr_test…` → validated address;
 * `name.ada` → CNS; `$handle` or a bare handle string → the handle NFT's holder.
 */
export const resolveRecipient = (
  input: string,
  rail: CardanoRail,
): Effect.Effect<ResolvedRecipient, NameResolutionError> => {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    return Effect.fail(new NameResolutionError({kind: 'invalid-address', reason: 'empty'}))
  }
  // Another chain's address is not an invalid one. Resolving it here would report "enter a valid
  // address" for something the user pasted correctly, and hide which rail it actually belongs to.
  const route = routeRecipient(trimmed, rail.config.network)
  if (route.rail === 'midnight') {
    return Effect.fail(
      new NameResolutionError({
        kind: 'midnight-address',
        reason: `${route.kind} Midnight address on ${route.network}${route.onOurNetwork ? '' : ' (another network)'}`,
      }),
    )
  }
  if (route.rail === 'unusable') {
    return Effect.fail(
      route.reason === 'dust-address'
        ? new NameResolutionError({kind: 'midnight-dust-address', reason: 'a DUST address receives, it cannot pay'})
        : new NameResolutionError({kind: 'midnight-damaged', reason: route.reason}),
    )
  }
  if (trimmed.startsWith('addr')) return resolveAddress(trimmed, rail)
  if (trimmed.toLowerCase().endsWith('.ada')) return resolveCns(trimmed, rail)
  if (trimmed.startsWith('$') || HANDLE_RE.test(trimmed)) return resolveHandle(trimmed, rail)
  return resolveAddress(trimmed, rail)
}
