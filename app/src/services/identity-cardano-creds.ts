/**
 * The identity's Cardano credentials — the (payment, stake) key-hash pair the
 * forum identity signs with.
 *
 * The identity is Midnight-first and is not a wallet group, but it *does* derive
 * CIP-1852 credentials under account 0 and sign with them, purely as an
 * identifier and never for funds:
 *
 *  - **stake** key (`0/2/0`) — the Koios per-identity authenticated tier
 *    (`services/cardano/koios-register.ts`)
 *  - **payment** key (`0/0/0`) — the durable SteelSwap pricing key
 *    (`services/cardano-assets/steelswap-register.ts`)
 *
 * Transaction review needs the *hashes* to tell "the ID received this" from "a
 * stranger received this", and identifying a party must never cost a biometric
 * prompt. So the hashes are derived and persisted **eagerly, when the identity
 * seed is stored** — the same rule wallet xpubs follow — and read back as plain
 * data afterwards. They are public key hashes, not secrets; only *signing* with
 * them needs the mnemonic.
 *
 * @module
 */

import {Keys} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {logger} from '../logger'
import {storage} from '../platform/storage'

/** Storage key for the persisted pair. Public hashes — no vault needed. */
const IDENTITY_CARDANO_CREDS_KEY = '@pnyx/identity_cardano_creds'

/**
 * CIP-1852 account the identity signs under. Both register services use
 * account 0; keep them in step — changing this orphans every persisted pair.
 */
const IDENTITY_ACCOUNT = 0
/** External payment chain / index — the SteelSwap signing key. */
const PAYMENT_ROLE = 0
/** Stake chain / index — the Koios registration key. */
const STAKE_ROLE = 2

export type IdentityCardanoCreds = {
  /** blake2b-224 hash of the identity's payment verification key. */
  readonly paymentKeyHashHex: string
  /** blake2b-224 hash of the identity's stake verification key. */
  readonly stakeKeyHashHex: string
}

/**
 * Derive the identity's Cardano key-hash pair from its mnemonic. Pure crypto,
 * no network, no storage. Fails rather than returning partial data — a wrong
 * hash would mis-attribute a party in review.
 */
export const deriveIdentityCardanoCreds = (mnemonic: string): Effect.Effect<IdentityCardanoCreds, unknown> =>
  Effect.gen(function* () {
    const root = yield* Keys.rootKeyFromMnemonic(mnemonic)
    const paymentXprvHex = yield* Keys.deriveCip1852(root, IDENTITY_ACCOUNT, PAYMENT_ROLE, 0)
    const stakeXprvHex = yield* Keys.deriveCip1852(root, IDENTITY_ACCOUNT, STAKE_ROLE, 0)
    return {
      paymentKeyHashHex: yield* Keys.keyHashOf(paymentXprvHex),
      stakeKeyHashHex: yield* Keys.keyHashOf(stakeXprvHex),
    }
  })

/** Shape-check a decoded storage payload; anything else is treated as absent. */
export const parseIdentityCardanoCreds = (value: string | null | undefined): IdentityCardanoCreds | null => {
  if (value === null || value === undefined || value.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null) return null
    const {paymentKeyHashHex, stakeKeyHashHex} = parsed as Partial<IdentityCardanoCreds>
    if (typeof paymentKeyHashHex !== 'string' || paymentKeyHashHex.length === 0) return null
    if (typeof stakeKeyHashHex !== 'string' || stakeKeyHashHex.length === 0) return null
    return {paymentKeyHashHex, stakeKeyHashHex}
  } catch (e: unknown) {
    logger.warn('Stored identity Cardano credentials could not be read; treating them as absent', {
      origin: 'identity-cardano-creds',
      error: String(e),
    })
    return null
  }
}

/**
 * Derive + persist the pair for a just-stored identity seed.
 *
 * Called from `storeIdentityMnemonic`, the single choke point for a stored
 * identity seed. **Rejects on failure** — the
 * xpub rule: a swallowed derivation error is a silently broken feature, and the
 * caller is the one place that still holds the mnemonic to retry with.
 */
export const persistIdentityCardanoCreds = async (mnemonic: string): Promise<IdentityCardanoCreds> => {
  const creds = await Effect.runPromise(deriveIdentityCardanoCreds(mnemonic))
  await storage.set(IDENTITY_CARDANO_CREDS_KEY, JSON.stringify(creds))
  logger.info('Persisted identity Cardano credentials', {origin: 'identity-cardano-creds'})
  return creds
}

/**
 * The persisted pair, or `null` when this install predates it (or has no
 * identity). Deliberately does **not** derive on miss: that would need the
 * mnemonic, and identifying a party in review must not prompt for biometrics.
 * A `null` simply means the ID tier does not render.
 */
export const readIdentityCardanoCreds = async (): Promise<IdentityCardanoCreds | null> => {
  try {
    return parseIdentityCardanoCreds(await storage.get(IDENTITY_CARDANO_CREDS_KEY))
  } catch (e) {
    logger.warn('Failed to read identity Cardano credentials', {origin: 'identity-cardano-creds', error: e})
    return null
  }
}

/** Drop the persisted pair (identity reset). */
export const clearIdentityCardanoCreds = (): Promise<void> => storage.remove(IDENTITY_CARDANO_CREDS_KEY)
