/**
 * Process-local cache for the identity's **derived Cardano role keys**, with a
 * lifetime.
 *
 * ### What this is, and what it is not
 *
 * The four app-infrastructure signers exempted from review in Phase 16 item 41
 * (`koios-register`, `steelswap-register`, `steelswap-auth`, `pnyx-session`)
 * need seed-derived keys to sign server challenges the user never asked for. They
 * already avoided re-prompting — but ad hoc: `ensureSteelswapKey` guards on a
 * module flag and parks the derived xprv inside a signer closure, Koios registers
 * once, and each hold survives until the process dies with **no eviction on
 * lock**.
 *
 * So this module does not *add* caching. It replaces scattered
 * hold-until-process-death with one named hold that **evicts on lock**, which
 * makes residency shorter, not longer. Do not "optimise" it back into a closure.
 *
 * ### Why the keys and not the mnemonic
 *
 * Caching what `retrieveIdentityMnemonic` returns would hand over everything
 * derivable from the identity seed, Midnight witness material included. The two
 * keys here cannot derive each other, cannot produce a Midnight witness, and
 * cannot sign for a funds wallet, so the blast radius is bounded by construction
 * rather than by discipline. The identity seed is not harmless — it roots the
 * forum identity, SIWM sessions and per-circle personas — which is exactly why
 * the cache sits *below* it.
 *
 * The **Midnight SIWM key is deliberately absent**: it is derived once at unlock
 * and wiped immediately (`pnyx-session.ts`), the strictest handling in the app.
 * There is no second prompt to avoid, so caching it would extend residency and
 * buy nothing.
 *
 * ### Lifetime (locked 2026-07-29)
 *
 * **Survives `background`, evicted on lock.** Backgrounding is constant on mobile
 * and is not a security event; evicting there would re-prompt all day and defeat
 * the purpose. Locking is an explicit user signal. This is a deliberate, narrowed
 * re-grant of the residency the 2026-07-26 ceremony-cache change removed — it
 * applies to ID keys only, and it must not widen to survive lock (which would
 * give the ID surface a longer life than the funds surface) or to hold the
 * mnemonic.
 *
 * @module
 */

import {XprvHex} from '@evolution-sdk/review/Brands'
import {Address, Keys} from '@pnyx/cardano-core'
import {asSecretText, type Mnemonic, type SecretText} from '@pnyx/crypto'
import {Effect} from 'effect'
import {retrieveIdentityMnemonic} from './identity-wallet'

/** CIP-1852 role indices: 0 = external payment, 2 = stake. */
const EXTERNAL_ROLE = 0
const STAKE_ROLE = 2

type RoleKind = 'stake' | 'payment'

/** Cache key: the same account index can be used for different roles. */
const cacheKeyOf = (kind: RoleKind, account: number): string => `${kind}:${account}`

const cache = new Map<string, SecretText>()

const deriveRoleKey = (mnemonic: Mnemonic, kind: RoleKind, account: number): Promise<SecretText> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const root = yield* Keys.rootKeyFromMnemonic(mnemonic)
      const derived = yield* Keys.deriveCip1852(root, account, kind === 'stake' ? STAKE_ROLE : EXTERNAL_ROLE, 0)
      // Minted from a chain that began at a branded `Mnemonic`, so the brand is earned, not asserted.
      return asSecretText(derived)
    }),
  )

/**
 * In-flight derivations, so two concurrent callers share one vault retrieve.
 *
 * Without this, a rail warming SteelSwap while Koios registers fires two
 * biometric prompts for the same seed — the concurrent-mint bug shape already
 * seen on the CIP-8 path.
 */
const inFlight = new Map<string, Promise<SecretText>>()

const roleKey = (kind: RoleKind, account: number, authPrompt?: string): Promise<SecretText> => {
  const key = cacheKeyOf(kind, account)
  const cached = cache.get(key)
  if (cached !== undefined) return Promise.resolve(cached)

  const existing = inFlight.get(key)
  if (existing !== undefined) return existing

  const pending = (async () => {
    try {
      const mnemonic = await retrieveIdentityMnemonic(authPrompt)
      const derived = await deriveRoleKey(mnemonic, kind, account)
      cache.set(key, derived)
      return derived
    } finally {
      inFlight.delete(key)
    }
  })()
  inFlight.set(key, pending)
  return pending
}

/** The identity's stake xprv for `account` — the Koios authenticated tier's signing key. */
export const identityStakeXprv = (account: number, authPrompt?: string): Promise<SecretText> =>
  roleKey('stake', account, authPrompt)

/** The identity's external payment xprv for `account` — the durable SteelSwap pricing key. */
export const identityPaymentXprv = (account: number, authPrompt?: string): Promise<SecretText> =>
  roleKey('payment', account, authPrompt)

/** The reward (stake) address hex for a cached stake key — public, derived here to avoid a second retrieve. */
export const identityRewardHex = async (
  network: Address.Network,
  account: number,
  authPrompt?: string,
): Promise<string> => {
  const stakeXprv = await identityStakeXprv(account, authPrompt)
  const keyHashHex = await Effect.runPromise(Keys.keyHashOf(XprvHex(stakeXprv)))
  return Address.rewardHex(network, keyHashHex)
}

/**
 * Drop every cached role key. Called on lock (see `useIdentityRoleKeyLifecycle`)
 * — never on `background`.
 *
 * Honest about its limits: the strings are Hermes strings and cannot be wiped, so
 * this ends the *reachability* of the keys, not their presence in the heap. That
 * is the same ceiling `ceremony-cache.ts` documents, and the reason items 44/45
 * carry the memory-side risk rather than this module.
 */
export const clearIdentityRoleKeys = (): void => {
  cache.clear()
}

/** Test-only: observe cache occupancy without exposing key material. */
export const cachedIdentityRoleKeyCount = (): number => cache.size
