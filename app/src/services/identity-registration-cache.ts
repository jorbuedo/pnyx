/**
 * Remembers that an identity's row is already on chain, so login stops re-proving it.
 *
 * `ensureIdentityRegistered` answers "is this identity registered?" by reading the contract: a
 * marker query, then the whole ledger blob (~20 kB and growing with every registration), then a
 * native decode to find one row. That is the right check the *first* time. On every login after it,
 * it is a chain round trip to re-learn something that cannot have changed — and it sits on the
 * critical path between the user tapping Sign in and the app opening.
 *
 * **Only a successful login writes the flag.** Not a successful publish: the service verifies the
 * challenge against `authPub` read from the row, so a token coming back is end-to-end proof that the
 * row is there *and* readable. A publish that returned without error proves less than that.
 *
 * **The contract address is part of the key**, which is what makes a stale flag mostly impossible.
 * A redeploy — routine on preprod — changes the address, so every identity misses the cache and
 * re-registers against the new contract instead of trusting a row that no longer exists. The network
 * is in the key for the same reason at a coarser grain: `C` is network-scoped, so the same seed is a
 * different identity per network and must be tracked separately.
 *
 * Belt and braces for the case the key cannot catch (the row vanishing under a *stable* address):
 * a refused login clears the flag, so the next attempt takes the full path rather than failing the
 * same way forever.
 *
 * Not secret, and not authoritative — the chain is. Worst case for a lost or corrupt entry is one
 * slow login.
 *
 * @module
 */

import {logger} from '../logger'
import {storage} from '../platform/storage'

const ORIGIN = 'identity-registration-cache'

export type RegistrationScope = {
  /** The bech32m `pnyx_id`. */
  readonly identity: string
  readonly network: string
  /** Hex, as `/auth/config` reports it — the redeploy discriminator. */
  readonly contractAddress: string
}

/**
 * Scoped so a redeploy or a network change simply misses rather than reading as registered.
 *
 * Order is address-before-identity only for readability when dumping keys; nothing parses these.
 */
const keyFor = ({identity, network, contractAddress}: RegistrationScope): string =>
  `pnyx:identity-registered:${network}:${contractAddress}:${identity}`

/**
 * Whether a previous login already proved this identity's row exists.
 *
 * Synchronous (MMKV) on purpose: it gates a fast path, and making the caller await a read to decide
 * whether to skip a read would give some of the saving straight back.
 *
 * `false` on anything other than a definite hit — an unset key, a corrupt value, a storage error.
 * The consequence of a false negative is a slow login; of a false positive, a refused one.
 */
export const isIdentityRegistered = (scope: RegistrationScope): boolean => {
  try {
    return storage.getSync(keyFor(scope)) === '1'
  } catch (error) {
    logger.warn('registration cache unreadable', {origin: ORIGIN, error: String(error)})
    return false
  }
}

/** Record that login succeeded against this identity's row. Never throws — see the module note. */
export const markIdentityRegistered = async (scope: RegistrationScope): Promise<void> => {
  try {
    await storage.set(keyFor(scope), '1')
  } catch (error) {
    logger.warn('failed to record registration', {origin: ORIGIN, error: String(error)})
  }
}

/** Forget the flag, so the next login re-checks the chain. Never throws. */
export const clearIdentityRegistered = async (scope: RegistrationScope): Promise<void> => {
  try {
    await storage.remove(keyFor(scope))
  } catch (error) {
    logger.warn('failed to clear registration', {origin: ORIGIN, error: String(error)})
  }
}
