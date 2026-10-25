/**
 * Pnyx session service — logging in as an Pnyx identity from the device's own keys.
 *
 * The app holds the seed (enclave vault); this service derives the identity secret, makes sure the
 * identity's row is on chain, and signs a server challenge with the row's `authPub` key to get a
 * content-service JWT whose subject is `C` (`docs/PNYX_IDENTITY_PLAN.md`).
 *
 * This replaced SIWM, which signed a CAIP-122 message with the role-0 Midnight key and bound the
 * session to an `mn_addr`. The reason is not cryptographic taste: `mn_addr` is an identity the
 * contract cannot verify, so nothing on chain could authenticate what it named.
 *
 * Networking note: the app never talks to the Midnight node/indexer/proof server —
 * only to the content service, which owns proving and DUST sponsorship (see
 * docs/mobile-shell-plan.md). On the Android emulator the host machine is 10.0.2.2.
 */

import {ed25519} from '@noble/curves/ed25519.js'
import {
  authChallengeMessage,
  authKeyPair,
  encodePnyxId,
  identityCommitmentOf,
  identitySkFromForumRoot,
} from '@pnyx/contract-client/identity'
import {forumRoot} from '@pnyx/contract-client/persona'
import {hex} from '@pnyx/crypto'
import {mnemonicToSeed} from '@pnyx/wallet'
import {Effect} from 'effect'
import {serviceUrl as envServiceUrl} from '../config/env'
import {logger} from '../logger'
import {declaredIdentityNetwork, identityNetworkDisagreement} from './identity-network'
import {clearIdentityRegistered, isIdentityRegistered, markIdentityRegistered} from './identity-registration-cache'
import {readTokenLifetime, type TokenLifetime} from './session-token'
import {recordInfraSignature} from './signing-audit'

/**
 * Re-exported so the many callers here keep one import, but the value now comes from the env
 * manifest and has **no default**. The old `?? http://10.0.2.2:3300` was an emulator-only loopback
 * alias: unroutable from a physical device, unset in `env/.env.production`, and the reason a
 * production build pointed the content service at nothing while every read looked healthy.
 */
export const serviceUrl = envServiceUrl

export type PnyxSession = {
  readonly token: string
  readonly network: string
  /**
   * Seed-derived anonymous-identity master (spec §4.3), cached in-memory for the session so forum
   * actions can derive per-circle personas on-device without re-touching the enclave. Absent on the
   * web / manual-card path (no seed available); device proving is gated on its presence.
   */
  readonly forumRoot?: Uint8Array
  /**
   * When this token arrived, on the **device's** clock.
   *
   * Every age this app computes from it compares two readings of that same clock, never the token's
   * server-side `exp` (`./session-token`). It is what decides whether a token found on disk after a
   * cold start is still worth using (`./session-restore`).
   */
  readonly receivedAtMs: number
  /**
   * The Pnyx identity `C`, bech32m-encoded (`docs/PNYX_IDENTITY_PLAN.md`) — **the session's
   * subject**, and what a peer needs in order to message you.
   *
   * Not optional: the JWT was issued against this identity's row, so a session without it could not
   * exist. {@link address} is the Midnight *wallet* address, kept for wallet surfaces only.
   */
  readonly identity: string
  /**
   * The token's own `iat`/`exp`, when it carried them — what {@link refreshSessionToken} is scheduled
   * from. Optional because a token that does not state its life is refreshed on refusal instead.
   */
  readonly lifetime?: TokenLifetime
}

export class SignInError extends Error {
  constructor(
    readonly step: 'config' | 'network' | 'nonce' | 'derive' | 'exchange',
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'SignInError'
  }
}

/**
 * UI-facing failure buckets for a sign-in attempt:
 * - `unreachable` — the content service never answered (network / service down).
 * - `misconfigured` — the service answered, but it is not the backend this build was built for.
 * - `rejected` — the service answered and refused the login exchange.
 * - `wallet` — a key operation on the device failed (enclave unlock denied/cancelled, key
 *   derivation failed).
 * - `unknown` — anything else, and deliberately not folded into `wallet`. Doing so told users
 *   their keys could not be unlocked whenever *any* unexpected error escaped — a React Native
 *   dev-bundle `TypeError`, say — and, because `signInForUnlock` reads `wallet` as "the enclave
 *   refused", it also left the app locked after biometrics had already succeeded.
 */
export type SignInFailure = 'unreachable' | 'misconfigured' | 'rejected' | 'wallet' | 'unknown'

export const classifySignInError = (error: unknown): SignInFailure => {
  if (error instanceof SignInError) {
    if (error.step === 'config' || error.step === 'nonce') return 'unreachable'
    // Reachable but wrong: retrying cannot fix it, so it must not read as a connectivity blip.
    if (error.step === 'network') return 'misconfigured'
    if (error.step === 'exchange') {
      // The exchange step throws with a cause only when fetch itself rejected;
      // a non-OK HTTP response (no cause) means the service refused the sign-in.
      return error.cause === undefined ? 'rejected' : 'unreachable'
    }
    return 'wallet'
  }
  return 'unknown'
}

/**
 * How long any sign-in leg may take before it counts as unreachable.
 *
 * ⚠️ **A leg with no deadline is a lock screen with no way out.** Every call here goes to a Cloudflare
 * Worker, and `fetch` has no timeout of its own: a host that accepts the connection and then never
 * answers leaves the promise pending for ever. Unlock awaited that promise, so the button sat spinning
 * with nothing on screen and nothing in the log — there is no error path to log, which is exactly what
 * makes a hang worse than a failure. Generous enough for a cold radio, short enough that "unreachable"
 * is a verdict a person gets rather than waits for.
 */
export const SIGN_IN_TIMEOUT_MS = 15_000

/** `fetch` with a deadline. Hermes has no `AbortSignal.timeout`, hence the controller by hand. */
const fetchWithDeadline = async (url: string, init?: RequestInit): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SIGN_IN_TIMEOUT_MS)
  try {
    return await fetch(url, {...init, signal: controller.signal})
  } finally {
    clearTimeout(timer)
  }
}

const getJson = async <T>(path: string, step: SignInError['step']): Promise<T> => {
  let response: Response
  try {
    response = await fetchWithDeadline(`${serviceUrl()}${path}`)
  } catch (e) {
    throw new SignInError(step, `content service unreachable at ${serviceUrl()}${path}`, e)
  }
  if (!response.ok) {
    throw new SignInError(step, `${path} responded ${response.status}`)
  }
  return (await response.json()) as T
}

/**
 * The network to derive an `pnyx_id` on, before any sign-in has happened.
 *
 * Synchronous and offline, which is what it always should have been: deriving an identity is ~1 ms of
 * local hashing and the only thing it needs from outside is the network *string*, a build-time fact.
 *
 * It used to fall back to `GET /auth/config` when the build declared nothing. That path is gone.
 * `EXPO_PUBLIC_PNYX_NETWORK` is required, so there is nothing to discover — and the discovery was
 * what turned a misconfigured service URL into an onboarding screen that sat on a TCP timeout and
 * then said "Pnyx is unreachable" about work that touches no network at all. A build pointed at a
 * local standalone chain sets the variable to that chain's network like any other build.
 *
 * The declaration is still not trusted: {@link signInWithMidnight} checks it against `/auth/config`
 * and fails loudly on a disagreement.
 */
export const resolveIdentityNetwork = (): string => declaredIdentityNetwork()

/**
 * The origin a signed challenge binds to, as the service reports it.
 *
 * Inside every signature the identity key produces, so a challenge answered for one deployment
 * cannot be replayed against another. `null` when the service is unreachable — callers must skip
 * signing rather than guess a domain, since a signature over the wrong one simply fails to verify.
 */
export const fetchAuthDomain = async (): Promise<string | null> => {
  try {
    const {domain} = await getJson<{domain: string}>('/auth/config', 'config')
    return domain === '' ? null : domain
  } catch (e: unknown) {
    // `null` also means "the service returned an empty domain", and login cannot proceed either
    // way — but only one of the two is the service being unreachable.
    logger.warn('Auth domain could not be fetched', {origin: 'pnyx-session', error: String(e)})
    return null
  }
}

/** A fresh single-use nonce for a challenge this device is about to sign. */
export const fetchAuthNonce = async (): Promise<string | null> => {
  try {
    const {nonce} = await getJson<{nonce: string}>('/auth/nonce', 'nonce')
    return nonce === '' ? null : nonce
  } catch (e: unknown) {
    logger.warn('Auth nonce could not be fetched; the challenge cannot be signed', {
      origin: 'pnyx-session',
      error: String(e),
    })
    return null
  }
}

/** What identifies the row a cached "already registered" flag refers to. */
type RegistrationScope = {readonly identity: string; readonly network: string; readonly contractAddress: string}

/**
 * This identity's contract address, derived once per identity.
 *
 * Pure function of `C` — one contract per identity, derived rather than configured — so the answer
 * cannot change while the app runs, and it reaches the native module, which a refresh has no reason to
 * pay for again.
 *
 * ⚠️ **Only a success is remembered.** Caching the `undefined` would turn one unavailable-native-module
 * moment into a permanent one, which is the shape of bug that has cost this codebase whole surfaces
 * before.
 */
const contractAddresses = new Map<string, string>()

const contractAddressFor = async (commitment: Uint8Array): Promise<string | undefined> => {
  const key = hex.encode(commitment)
  const known = contractAddresses.get(key)
  if (known !== undefined) return known
  const derived = await import('./identity-contract')
    .then(({identityContractAddressFor}) => identityContractAddressFor(commitment))
    .then((address) => hex.encode(address))
    .catch((error: unknown) => {
      // ⚠️ The **import** is inside the catch too, not just the call. It reaches the native module, so
      // it throws wherever that is unavailable — and an uncaught throw here fails the whole sign-in,
      // which is not what "we could not derive an address" should cost. Registration is skipped
      // instead, and the login either works or reports its own reason.
      logger.warn('could not derive this identity\u2019s contract address', {
        origin: 'PnyxSession',
        error: String(error),
      })
      return undefined
    })
  if (derived !== undefined) contractAddresses.set(key, derived)
  return derived
}

/**
 * A signed challenge, exchanged for a token.
 *
 * Split out because **a refresh is this half and nothing else.** The expensive part of signing in —
 * the enclave, the seed, `forumRoot`, the registration check — produces material the session already
 * holds for its whole life, so replacing a lapsed token needs a nonce, a signature and one POST. No
 * prompt, no chain read, no new capability: the app could already mint a session at any moment, and
 * this only stops it throwing one away.
 */
const exchangeChallenge = async (params: {
  readonly identity: string
  readonly authSecretKey: Uint8Array
  readonly domain: string
  readonly network: string
  readonly nonce: string
  readonly contractAddress: string | undefined
  /**
   * Present only when the row read was *skipped* on a cached flag. A refusal is then the one signal
   * that the row we shortcut past may be gone, so the flag is cleared and the next attempt re-registers
   * instead of failing identically for ever.
   */
  readonly cachedRegistration: RegistrationScope | undefined
}): Promise<{readonly token: string; readonly lifetime: TokenLifetime | undefined}> => {
  const challenge = authChallengeMessage(params.domain, params.network, params.identity, params.nonce)
  const signature = ed25519.sign(challenge, params.authSecretKey)
  params.authSecretKey.fill(0)
  void recordInfraSignature({
    purpose: 'identity-login',
    payloadHex: hex.encode(challenge),
    signer: params.identity,
    signerKind: 'pnyx-id',
  })

  let response: Response
  try {
    response = await fetchWithDeadline(`${serviceUrl()}/auth/identity`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      // The contract is named, not looked up: one contract per identity, so the service has no address
      // to configure. It does not have to trust this — it checks the code digest of whatever is there
      // and the decoder refuses a contract sealed to a different `C`.
      body: JSON.stringify({
        identity: params.identity,
        nonce: params.nonce,
        signature: hex.encode(signature),
        ...(params.contractAddress === undefined ? {} : {contract: params.contractAddress}),
      }),
    })
  } catch (e) {
    throw new SignInError('exchange', 'content service unreachable during token exchange', e)
  }
  if (!response.ok) {
    const body = await response.text().catch((e: unknown) => {
      logger.warn('login refusal body could not be read', {
        origin: 'PnyxSession',
        status: response.status,
        error: String(e),
      })
      return ''
    })
    if (params.cachedRegistration !== undefined) {
      await clearIdentityRegistered(params.cachedRegistration)
      logger.warn('login refused on a cached registration; will re-register next attempt', {
        origin: 'PnyxSession',
        identity: params.identity,
      })
    }
    throw new SignInError('exchange', `login rejected (${response.status}): ${body.slice(0, 200)}`)
  }
  const {token} = (await response.json()) as {token: string}
  return {token, lifetime: readTokenLifetime(token)}
}

/**
 * `forumRoot` from a mnemonic, with no network anywhere in it.
 *
 * ⚠️ **Split out because a purely local feature was inheriting a backend dependency it never had.**
 * This is `HKDF-SHA256(seed, "pnyx:root")` — the vault unlock is its only prerequisite. It used to
 * be computed *inside* `signInWithMidnight` and thrown away unless the whole handshake succeeded, so
 * anything wanting it had to sign in first. Notes to self did, for no reason.
 *
 * The seed is zeroed here, as it is on the sign-in path: it exists only to produce this.
 */
export const forumRootFromMnemonic = async (mnemonic: string): Promise<Uint8Array> => {
  const seed = await mnemonicToSeed(mnemonic).catch((e: unknown) => {
    throw new SignInError('derive', 'failed to derive the seed from the mnemonic', e)
  })
  const root = forumRoot(seed)
  seed.fill(0)
  return root
}

export const signInWithMidnight = async (mnemonic: string, derivedRoot?: Uint8Array): Promise<PnyxSession> => {
  // `chain.identityContractAddress` is no longer read: with one contract per identity there is no
  // single address to configure, and the app derives its own (`services/identity-contract.ts`). The
  // service still reports one for its own use.
  const config = await getJson<{domain: string; network: string}>('/auth/config', 'config')
  // A build that declares its network must be talking to that network's service. Checked before any
  // key derivation: deriving on a network the service does not serve produces a `C` whose row can
  // never be found, which surfaces as an unexplained login rejection rather than as the
  // configuration fault it is.
  const disagreement = identityNetworkDisagreement(declaredIdentityNetwork(), config.network)
  if (disagreement !== undefined) {
    throw new SignInError('network', `identity network mismatch: ${disagreement}`)
  }

  // Issued now, consumed at the challenge below. Nothing between here and there needs it, and what
  // sits in between is the expensive part of sign-in — key derivation, the lazy prover/MLS imports
  // and `ensureIdentityRegistered`'s indexer read — so awaiting it here put a whole round trip on
  // the critical path for no reason. Deliberately *after* the network guard, so a build talking to
  // the wrong service still rejects without issuing a nonce it could never spend.
  //
  // Safe against expiry: the store's TTL is 5 minutes (`services/content/src/nonce.ts`) and the
  // slowest thing in between is a first-time registration, measured at ~42 s.
  const nonceRequest = getJson<{nonce: string}>('/auth/nonce', 'nonce')
  // A throw before the challenge abandons this request; without a sink its rejection would surface
  // as an unhandled rejection. Awaiting `nonceRequest` later still rethrows.
  nonceRequest.catch((e: unknown) => {
    logger.debug('nonce request abandoned before the challenge', {origin: 'PnyxSession', error: String(e)})
  })

  // Reused when the caller already derived it at unlock — `mnemonicToSeed` is PBKDF2 and paying for
  // it twice on the sign-in path would be pure waste.
  //
  // No Midnight *signing* key is derived here any more: it existed only to compute the session's
  // `mn_addr`, which nothing reads since the identity migration. Not deriving it means sign-in
  // handles one less piece of secret material (docs/PNYX_IDENTITY_PLAN.md).
  const root = derivedRoot ?? (await forumRootFromMnemonic(mnemonic))
  // Derived here rather than on demand so the secret's lifetime is the session's, matching
  // forumRoot. Only `C` is retained; `identitySk` is re-derived when a row is actually published.
  const identitySk = identitySkFromForumRoot(root)
  const identity = encodePnyxId(identityCommitmentOf(identitySk))

  // Login proves control of the identity row, not of an `mn_addr`. What makes it sound is not
  // What makes it sound is not the scheme (Ed25519, verified only by our service) but that
  // `authPub` lives in a row only `identitySk`'s holder could have written.
  const auth = authKeyPair(identitySk)
  // Registration precedes the first login, not the other way round: login reads `authPub` from
  // the row, so publishing afterwards would deadlock a fresh identity. Idempotent — an existing
  // row short-circuits — and a `false` return means this build cannot register (no chain, no
  // artifacts, no prover), which login will then report honestly rather than looping.
  // ⚠️ **Derived, not configured.** There is one contract per identity and its address is a pure
  // function of `C`, so nothing here reads `/auth/config`'s address any more — a config value could
  // only ever have named one identity's contract, and naming the wrong one is how a login would read
  // somebody else's `authPub`. Lazy because the derivation reaches the native module.
  const contractAddress = await contractAddressFor(identityCommitmentOf(identitySk))
  const registrationScope =
    contractAddress !== undefined ? {identity, network: config.network, contractAddress} : undefined
  // A login that already succeeded against this row is proof it exists, so re-deriving MLS and
  // re-reading the ledger to confirm it buys nothing and costs the user the wait. The flag is keyed
  // on the contract address, so a template change — which moves every identity's contract — misses it
  // and the full path runs again.
  const skipRegistration = registrationScope !== undefined && isIdentityRegistered(registrationScope)
  if (registrationScope !== undefined && !skipRegistration) {
    // Both imported lazily: `identity-publish` reaches the native prover and `dm-mls` the MLS
    // stack, and static imports would drag either into everything that touches a session
    // (dm-api → dm-start).
    const [{ensureIdentityRegistered}, {deriveMlsIdentity}] = await Promise.all([
      import('./identity-publish'),
      import('./dm-mls'),
    ])
    // The row's `anchor` is the **MLS signature public key**, not `authPub`: it is what a peer
    // checks our KeyPackages against (`verifyKeyPackageAnchor`). Publishing `authPub` here would
    // make every incoming conversation fail as `key-package-rejected`.
    const mls = await Effect.runPromise(deriveMlsIdentity(root))
    // Logged, never rethrown. A failure here is not fatal to *this* call — the login below will
    // fail on its own and say so — but it is the cause, and swallowing it silently leaves
    // "identity has not been registered" with nothing behind it to debug.
    const registered = await ensureIdentityRegistered({
      identity,
      anchor: mls.publicKey,
      authPub: auth.publicKey,
      identitySk,
      networkId: config.network,
      // Absolute, not a duration: a bare 3600 writes Timestamp(3600) — 1970 — and the node
      // rejects the intent as expired.
      expiresAtSecs: Math.floor(Date.now() / 1000) + 3600,
    }).catch((error: unknown) => {
      // `stage` read structurally rather than via `instanceof IdentityPublishError`: importing the
      // class would statically pull `identity-publish`, defeating the lazy import above.
      logger.warn('identity registration failed', {
        origin: 'PnyxSession',
        stage: String((error as {stage?: unknown} | undefined)?.stage ?? 'unknown'),
        error: String(error),
        cause: String((error as {cause?: unknown} | undefined)?.cause ?? ''),
      })
      return false
    })
    if (!registered) {
      logger.warn('identity is not registered; login will be refused', {origin: 'PnyxSession', identity})
    }
  }
  const {nonce} = await nonceRequest
  const {token, lifetime} = await exchangeChallenge({
    identity,
    authSecretKey: auth.secretKey,
    domain: config.domain,
    network: config.network,
    nonce,
    contractAddress,
    cachedRegistration: skipRegistration ? registrationScope : undefined,
  })

  // End-to-end proof the row exists and is readable: this token was only issued because the service
  // verified the challenge against `authPub` from it. Not awaited — a failed write costs one slow
  // login, and the session must not wait on a cache.
  if (registrationScope !== undefined) void markIdentityRegistered(registrationScope)

  return {
    token,
    network: config.network,
    forumRoot: root,
    identity,
    receivedAtMs: Date.now(),
    ...(lifetime === undefined ? {} : {lifetime}),
  }
}

/**
 * Replace a lapsed (or lapsing) token without touching the enclave.
 *
 * Needs only what the session already carries: `forumRoot` is cached deliberately so forum proving
 * does not re-prompt, and `authPriv` is two HKDFs from it. Registration is never attempted here — if
 * the row has gone, the exchange is refused, the cached flag is cleared and the caller falls back to a
 * full sign-in, which is the one path that can publish a row.
 *
 * ⚠️ **Throws like a sign-in, on purpose.** `classifySignInError` buckets the failure, so a caller
 * decides between "retry later" and "ask the user" from the same table login uses.
 */
export const refreshSessionToken = async (session: PnyxSession): Promise<PnyxSession> => {
  const root = session.forumRoot
  if (root === undefined) {
    // Not an error path with a fallback: there is genuinely nothing to sign with, and pretending
    // otherwise would produce a signature no `authPub` matches.
    throw new SignInError('derive', 'this session carries no forum root, so it cannot be refreshed')
  }
  // Both round trips at once — neither needs the other, and a refresh is meant to be cheap.
  const configRequest = getJson<{domain: string; network: string}>('/auth/config', 'config')
  const nonceRequest = getJson<{nonce: string}>('/auth/nonce', 'nonce')
  nonceRequest.catch((e: unknown) => {
    logger.debug('nonce request abandoned before the refresh challenge', {
      origin: 'PnyxSession',
      error: String(e),
    })
  })
  const config = await configRequest
  const disagreement = identityNetworkDisagreement(declaredIdentityNetwork(), config.network)
  if (disagreement !== undefined) {
    throw new SignInError('network', `identity network mismatch: ${disagreement}`)
  }

  const identitySk = identitySkFromForumRoot(root)
  const commitment = identityCommitmentOf(identitySk)
  const identity = encodePnyxId(commitment)
  const auth = authKeyPair(identitySk)
  const contractAddress = await contractAddressFor(commitment)
  const registrationScope =
    contractAddress !== undefined ? {identity, network: config.network, contractAddress} : undefined

  const {nonce} = await nonceRequest
  const {token, lifetime} = await exchangeChallenge({
    identity,
    authSecretKey: auth.secretKey,
    domain: config.domain,
    network: config.network,
    nonce,
    contractAddress,
    // A refresh always skips the row read, so a refusal always means the flag may be stale.
    cachedRegistration: registrationScope,
  })
  logger.debug('session token refreshed', {origin: 'PnyxSession', identity})
  return {
    ...session,
    token,
    network: config.network,
    identity,
    receivedAtMs: Date.now(),
    ...(lifetime === undefined ? {} : {lifetime}),
  }
}
