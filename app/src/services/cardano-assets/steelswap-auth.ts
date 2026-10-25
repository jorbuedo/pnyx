/**
 * SteelSwap `/api/v2/*` bearer-key auth — the Pnyx partner key when the build carries one, a
 * per-install CIP-8 durable key otherwise.
 *
 * ⚠️ **The two are not interchangeable, and the difference is money.** SteelSwap derives a swap's
 * fee channel from the authenticated principal and never from a request field, so a CIP-8 key —
 * which auto-provisions a `self_serve` partner for whoever logged in — attributes the fee to the
 * user. The partner key is the only principal that attributes it to Pnyx. Everything else about the
 * two is identical: same header, same routes.
 *
 * A partner key is also **not ours to re-mint**: our account carries no `maintenance_address`, so
 * the CIP-8 login that mints and revokes cannot resolve to it. A `401` on it is therefore an
 * operational fact to report, never a trigger to mint a replacement — see
 * {@link invalidateSteelswapKey}.
 *
 * `challenge → wallet signs (COSESign1) → verify → keys` yields a durable API
 * key. We mint it once via the registered {@link SteelswapSigner} (the Pnyx
 * identity's Cardano key — see `steelswap-register.ts`), persist it (durable
 * keys don't expire), and reuse it across every wallet incl. read-only ones.
 *
 * There is no anonymous fallback: `POST /api/v2/auth/anon` was **removed** from
 * the API (verified 2026-09-03 — it answers `404 not_found`), so a caller with
 * neither a partner key nor a signer fails typed rather than firing a request
 * that cannot succeed.
 *
 * A 401 invalidates the durable key so the next call re-mints. A **409** on the
 * mint means the server still holds an active key we no longer have locally
 * (cleared storage, reinstall); {@link mintDurableKey} revokes it and retries
 * once, because without that the account is locked out permanently.
 *
 * @module
 */

import {Data, Effect} from 'effect'
import {logger} from '../../logger'
import type {CardanoAssetsConfig} from './config'
import {resetSteelswapCredentialState, setSteelswapCredentialState} from './steelswap-credential-state'
import type {FetchLike} from './token-metadata'

export class SteelswapAuthError extends Data.TaggedError('SteelswapAuthError')<{readonly reason: string}> {}

const utf8ToHex = (s: string): string =>
  [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('')

/**
 * Durable-key persistence, injected at app init so this module stays free of
 * platform (`react-native-mmkv`) coupling and unit-testable. When unbound the
 * durable key is RAM-only (re-minted once per process).
 */
export type SteelswapKeyStore = {
  readonly get: (key: string) => Promise<string | null>
  readonly set: (key: string, value: string) => Promise<void>
  readonly remove: (key: string) => Promise<void>
}

let keyStore: SteelswapKeyStore | null = null

/** Bind (or clear) the durable-key persistence. Called once at app init. */
export const setSteelswapKeyStore = (s: SteelswapKeyStore | null): void => {
  keyStore = s
}

// ── CIP-8 durable key ────────────────────────────────────────────────────────

/**
 * Signs SteelSwap's CIP-8 challenge with the Pnyx identity's Cardano key.
 * `addressBech32` is the address the challenge binds to; `sign` returns the
 * COSESign1 `{signature, key}` for a hex payload (see `Cose.signData`). Injected
 * so this module stays free of key-management / React deps and is unit-testable.
 */
export type SteelswapSigner = {
  readonly addressBech32: string
  readonly sign: (payloadHex: string) => Promise<{readonly signature: string; readonly key: string}>
}

/**
 * How the identity signer is supplied.
 *
 * ⚠️ **A function, because building one is expensive and usually unnecessary.**
 * Deriving the identity's Cardano key reads the vault and runs PBKDF2 in JS — measured
 * at **14.8 s of a 61 s boot** on a real device. The signer is read in exactly one
 * place, the mint branch below, and a durable key that is already persisted never
 * reaches it. Registering a thunk means that cost is paid on a first run or after a
 * 401, and not on every launch.
 *
 * An already-built signer is still accepted: the stub and the tests have one to hand
 * and nothing is gained by making them lazy.
 */
export type SteelswapSignerSource = SteelswapSigner | (() => Promise<SteelswapSigner>)

let signer: SteelswapSignerSource | null = null

/** Register (or clear) the identity signer used to mint the durable key. */
export const setSteelswapSigner = (s: SteelswapSignerSource | null): void => {
  signer = s
}

/** Resolve the registered source, building the signer only if it has not been built. */
const resolveSigner = (source: SteelswapSignerSource): Effect.Effect<SteelswapSigner, SteelswapAuthError> =>
  typeof source === 'function'
    ? Effect.tryPromise({
        try: () => source(),
        catch: (e) => new SteelswapAuthError({reason: `signer unavailable: ${String(e)}`}),
      })
    : Effect.succeed(source)

/** Persisted durable-key namespace (plaintext MMKV, mirroring the Koios JWT). */
const durableKeyStorageKey = (network: string): string => `@pnyx/steelswap-key/${network}`

/** In-memory durable key per network (hydrated from storage / freshly minted). */
const durableByNetwork = new Map<string, string>()

/** Drop every cached key and in-flight mint — tests only. */
export const resetSteelswapAuth = (): void => {
  durableByNetwork.clear()
  mintInflight.clear()
  resetSteelswapCredentialState()
}

/**
 * Drop the durable key (RAM + persisted) — after a 401 so the next call re-mints.
 *
 * ⚠️ A no-op when the build authenticates with the partner key, and the caller must not retry: that
 * key is minted out-of-band and cannot be replaced from the app, so clearing the CIP-8 cache would
 * only hide the real failure (a revoked or deactivated partner credential) behind a mint the next
 * call cannot use. Returns whether anything was dropped, so the retry decision reads the same fact
 * this function acted on rather than re-deriving it.
 */
export const invalidateSteelswapKey = (config: CardanoAssetsConfig): boolean => {
  const network = config.network
  // Nothing of ours was sent, so there is nothing to invalidate and nothing a retry would change:
  // a 401 here is the endpoint's own credential being rejected, which only an operator can fix.
  if (config.steelswapKeyInjectedByEndpoint) {
    logger.error('The swap endpoint rejected its own injected credential; swap reads will fail', {
      origin: 'steelswap-auth',
      network,
    })
    return false
  }
  if (config.steelswapPartnerKey !== undefined) {
    logger.error('SteelSwap rejected the Pnyx partner key; swaps now attribute no fee and reads may fail', {
      origin: 'steelswap-auth',
      network,
    })
    setSteelswapCredentialState({tag: 'partnerRejected'})
    return false
  }
  durableByNetwork.delete(network)
  void keyStore?.remove(durableKeyStorageKey(network)).catch((e) => {
    logger.warn('Failed to drop the persisted SteelSwap key; a stale key may be re-read', {
      origin: 'steelswap-auth',
      network,
      error: String(e),
    })
  })
  return true
}

/** Parsed JSON body of a fetch response, or a tagged failure. */
const readJson = (r: {json: () => Promise<unknown>}): Effect.Effect<Record<string, unknown>, SteelswapAuthError> =>
  Effect.tryPromise({
    try: async () => (await r.json()) as Record<string, unknown>,
    catch: (e) => new SteelswapAuthError({reason: e instanceof Error ? e.message : String(e)}),
  })

/**
 * Run the full CIP-8 mint: challenge → sign → verify → keys. Returns the durable
 * `api_key`. Fails with {@link SteelswapAuthError} on any transport/parse/auth
 * error (caller degrades to no durable key).
 */
const mintDurableKey = (
  config: CardanoAssetsConfig,
  s: SteelswapSigner,
  fetchImpl: FetchLike,
): Effect.Effect<string, SteelswapAuthError> =>
  Effect.gen(function* () {
    const url = (path: string) => `${config.steelswapUrl}${path}`
    const send = (path: string, init: {headers?: Record<string, string>; body?: string}) =>
      Effect.tryPromise({
        try: () =>
          fetchImpl(url(path), {
            method: 'post',
            headers: {Accept: 'application/json', ...(init.headers ?? {})},
            ...(init.body !== undefined ? {body: init.body} : {}),
          }),
        catch: (e) => new SteelswapAuthError({reason: e instanceof Error ? e.message : String(e)}),
      })

    // 1. challenge
    const chRes = yield* send('/api/v2/auth/cip8/challenge', {
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({address: s.addressBech32}),
    })
    if (!chRes.ok) return yield* Effect.fail(new SteelswapAuthError({reason: `cip8/challenge ${chRes.status}`}))
    const chBody = yield* readJson(chRes)
    const message = chBody.message
    if (typeof message !== 'string' || message.length === 0) {
      return yield* Effect.fail(new SteelswapAuthError({reason: 'cip8/challenge: missing message'}))
    }

    // 2. sign (COSESign1 over the canonical message bytes)
    const sig = yield* Effect.tryPromise({
      try: () => s.sign(utf8ToHex(message)),
      catch: (e) => new SteelswapAuthError({reason: `cip8 sign: ${e instanceof Error ? e.message : String(e)}`}),
    })

    // 3. verify → short-lived access token
    const vRes = yield* send('/api/v2/auth/cip8/verify', {
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({signature: sig.signature, key: sig.key}),
    })
    if (!vRes.ok) return yield* Effect.fail(new SteelswapAuthError({reason: `cip8/verify ${vRes.status}`}))
    const vBody = yield* readJson(vRes)
    const accessToken = vBody.access_token
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      return yield* Effect.fail(new SteelswapAuthError({reason: 'cip8/verify: missing access_token'}))
    }

    // 4. mint the durable key (bearer = access token)
    const auth = {authorization: `Bearer ${accessToken}`}
    let kRes = yield* send('/api/v2/auth/keys', {headers: auth})

    // 409 = the account already holds an ACTIVE key that we no longer have
    // locally (cleared storage, reinstall). The API mints only one at a time, so
    // without revoking it first this account can never authenticate again.
    if (kRes.status === 409) {
      yield* revokeActiveKeys(url, accessToken, fetchImpl)
      kRes = yield* send('/api/v2/auth/keys', {headers: auth})
    }

    if (!kRes.ok) return yield* Effect.fail(new SteelswapAuthError({reason: `auth/keys ${kRes.status}`}))
    const kBody = yield* readJson(kRes)
    const apiKey = kBody.api_key
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      return yield* Effect.fail(new SteelswapAuthError({reason: 'auth/keys: missing api_key'}))
    }
    return apiKey
  })

/**
 * Revoke every active key on the session's account, so a fresh one can be
 * minted. Best-effort per key: a revoke that fails is logged and the next is
 * still attempted, because one stale key left behind is what blocks the re-mint.
 */
const revokeActiveKeys = (
  url: (path: string) => string,
  accessToken: string,
  fetchImpl: FetchLike,
): Effect.Effect<void, SteelswapAuthError> =>
  Effect.gen(function* () {
    const auth = {Accept: 'application/json', authorization: `Bearer ${accessToken}`}
    const listRes = yield* Effect.tryPromise({
      try: () => fetchImpl(url('/api/v2/auth/keys'), {method: 'get', headers: auth}),
      catch: (e) => new SteelswapAuthError({reason: `auth/keys list: ${e instanceof Error ? e.message : String(e)}`}),
    })
    if (!listRes.ok) return yield* Effect.fail(new SteelswapAuthError({reason: `auth/keys list ${listRes.status}`}))
    const rows = yield* Effect.tryPromise({
      try: async () => (await listRes.json()) as unknown,
      catch: (e) => new SteelswapAuthError({reason: e instanceof Error ? e.message : String(e)}),
    })
    const prefixes = (Array.isArray(rows) ? rows : [])
      .map((r) => (r ?? {}) as {prefix?: unknown; is_active?: unknown})
      .filter((r) => r.is_active === true && typeof r.prefix === 'string' && r.prefix.length > 0)
      .map((r) => r.prefix as string)

    if (prefixes.length === 0) {
      logger.warn('SteelSwap answered 409 but lists no active key; the re-mint will fail', {
        origin: 'steelswap-auth',
      })
      return
    }
    for (const prefix of prefixes) {
      const res = yield* Effect.tryPromise({
        try: () => fetchImpl(url(`/api/v2/auth/keys/${prefix}`), {method: 'delete', headers: auth}),
        catch: (e) => new SteelswapAuthError({reason: e instanceof Error ? e.message : String(e)}),
      }).pipe(
        Effect.catchAll((e) => {
          logger.warn('SteelSwap key revoke failed; the re-mint may still be blocked', {
            origin: 'steelswap-auth',
            prefix,
            error: e.reason,
          })
          return Effect.succeed(null)
        }),
      )
      if (res !== null && !res.ok) {
        logger.warn('SteelSwap key revoke rejected; the re-mint may still be blocked', {
          origin: 'steelswap-auth',
          prefix,
          status: res.status,
        })
      }
    }
  })

/**
 * In-flight CIP-8 mints, per network.
 *
 * Without this, two concurrent callers that both miss RAM *and* storage each run
 * the whole `challenge → verify → keys` chain: six requests against a **daily**
 * quota instead of three, and the losing `auth/keys` answers 500. Observed live
 * on a first launch after the key was cleared, where the price sweep and the swap
 * estimate raced.
 */
const mintInflight = new Map<string, Promise<string>>()

/** {@link mintDurableKey}, but concurrent callers share one attempt. */
const mintDurableKeyOnce = (
  config: CardanoAssetsConfig,
  s: SteelswapSigner,
  fetchImpl: FetchLike,
): Effect.Effect<string, SteelswapAuthError> =>
  Effect.suspend(() => {
    const network = config.network
    const existing = mintInflight.get(network)
    if (existing !== undefined) {
      return Effect.tryPromise({
        try: () => existing,
        catch: () => new SteelswapAuthError({reason: 'cip8 mint (shared attempt) failed'}),
      })
    }
    const promise = Effect.runPromise(mintDurableKey(config, s, fetchImpl))
    mintInflight.set(network, promise)
    return Effect.tryPromise({
      try: () => promise,
      catch: (e) => new SteelswapAuthError({reason: `cip8 mint: ${e instanceof Error ? e.message : String(e)}`}),
    }).pipe(Effect.ensuring(Effect.sync(() => mintInflight.delete(network))))
  })

/**
 * A usable SteelSwap bearer key: the partner key when the build carries one, otherwise the durable
 * CIP-8 key — RAM → persisted → freshly minted via the registered signer. Fails when there is
 * neither (durable keys never expire, so there is nothing time-dependent here).
 */
export const getSteelswapKey = (
  config: CardanoAssetsConfig,
  fetchImpl: FetchLike,
): Effect.Effect<string, SteelswapAuthError> =>
  Effect.gen(function* () {
    // Asking for a key when the endpoint injects one is a caller bug: it would mint a per-install
    // CIP-8 key nothing sends. Callers go through `steelswapAuthHeaders`, which never gets here.
    if (config.steelswapKeyInjectedByEndpoint) {
      return yield* Effect.fail(new SteelswapAuthError({reason: 'the endpoint injects the credential'}))
    }
    // The partner key wins outright, and nothing below runs: no storage read, no signer built, no
    // mint. A build that holds it must never fall back to a per-install key, because the fallback
    // succeeds — it just pays the fee to the wrong principal, silently.
    if (config.steelswapPartnerKey !== undefined) {
      setSteelswapCredentialState({tag: 'partner'})
      return config.steelswapPartnerKey
    }

    const network = config.network
    const ram = durableByNetwork.get(network)
    if (ram !== undefined) {
      setSteelswapCredentialState({tag: 'ready'})
      return ram
    }

    // Persisted durable key (best-effort read; RAM-only when no store is bound).
    const stored = keyStore
      ? yield* Effect.tryPromise({
          try: () => keyStore?.get(durableKeyStorageKey(network)) ?? Promise.resolve(null),
          catch: () => new SteelswapAuthError({reason: 'storage read'}),
        }).pipe(Effect.orElseSucceed(() => null))
      : null
    if (stored !== null && stored.length > 0) {
      durableByNetwork.set(network, stored)
      setSteelswapCredentialState({tag: 'ready'})
      return stored
    }

    // Mint via the registered identity signer, then persist. Only here does the signer
    // get built — everything above answered from RAM or storage without it.
    const source = signer
    if (source !== null) {
      setSteelswapCredentialState({tag: 'minting'})
      const s = yield* resolveSigner(source).pipe(
        Effect.tapError((e) => Effect.sync(() => setSteelswapCredentialState({tag: 'failed', reason: e.reason}))),
      )
      const minted = yield* mintDurableKeyOnce(config, s, fetchImpl).pipe(
        Effect.tapError((e) => Effect.sync(() => setSteelswapCredentialState({tag: 'failed', reason: e.reason}))),
      )
      durableByNetwork.set(network, minted)
      setSteelswapCredentialState({tag: 'ready'})
      void keyStore?.set(durableKeyStorageKey(network), minted).catch((e) => {
        logger.warn('Failed to persist the SteelSwap key; the next session re-mints', {
          origin: 'steelswap-auth',
          network,
          error: String(e),
        })
      })
      return minted
    }

    // No signer (no identity yet, or a watch-only-only device). There is no
    // anonymous path any more, so this is a real absence the caller must show —
    // not a silent "no data".
    setSteelswapCredentialState({tag: 'noSigner'})
    return yield* Effect.fail(new SteelswapAuthError({reason: 'no signer registered'}))
  })

/**
 * The `authorization` header a SteelSwap `/api/v2/*` request should carry, which is **empty when
 * the endpoint injects the credential itself**.
 *
 * This is the whole reason the partner key can leave the published remote config. Without it, a
 * build that finds no key falls through to {@link getSteelswapKey}'s CIP-8 mint, and that mint
 * posts the wallet's address to SteelSwap — mainnet-only, so a testnet address is `400 Invalid
 * address` and the gate fails before any data request is made.
 */
export const steelswapAuthHeaders = (
  config: CardanoAssetsConfig,
  fetchImpl: FetchLike,
): Effect.Effect<Record<string, string>, SteelswapAuthError> =>
  config.steelswapKeyInjectedByEndpoint
    ? Effect.sync(() => {
        setSteelswapCredentialState({tag: 'endpoint'})
        return {}
      })
    : getSteelswapKey(config, fetchImpl).pipe(Effect.map((key) => ({authorization: `Bearer ${key}`})))
