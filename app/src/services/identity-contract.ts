/**
 * Where an identity's contract lives, and getting it deployed.
 *
 * **There is no registry any more.** One contract per identity
 * (`docs/BOUNDED_STATE_ARCHITECTURE.md` §1), and a Midnight address is content-derived — so the
 * address is a pure function of `C` and the template's verifier keys. That is what makes a peer lookup
 * free: hash nothing, ask the indexer whether anything is at the derived address, and download only
 * that one identity's ledger rather than everybody's.
 *
 * ⚠️ **The address must be derived, never accepted.** A caller-supplied address would let anyone deploy
 * a contract of their own code sealed to somebody else's `C`, publish an `authPub` they hold, and be
 * logged in as them. Deriving is the whole authentication: the honest contract for `C` is the one at
 * `identityAddress(C)`, and the decoder additionally refuses a state whose sealed id is not `C`.
 *
 * **The shell comes before the row.** A brand-new identity's first transaction is a deploy, not a
 * write — `publishIdentityRow` has nowhere to write until it exists. The device cannot pay a Midnight
 * fee before it has synced DUST, so the deploy goes out unbalanced through the same `POST /register`
 * relay the row does, and the sponsor balances and submits it.
 *
 * @module
 */

import {decodePnyxId} from '@pnyx/contract-client/identity'
import {hex} from '@pnyx/crypto'
import {buildIdentityDeployTx, identityAddress} from '@pnyx/midnight-native'
import {logger} from '../logger'
import {fetchContractMarker} from './midnight/contract-state'
import {ensureVerifierKeys} from './pnyx-artifacts'
import {relaySponsoredTx} from './sponsored-relay'

const ORIGIN = 'identity-contract'

/**
 * Derivations are pure and the keys are a download, so the answer is cached for the process.
 *
 * Keyed by `C` alone: the verifier keys come from the template, and a recompile changes the cache
 * directory rather than this map — a stale entry would name the address of the *previous* template,
 * which is a different contract.
 */
const addresses = new Map<string, Uint8Array>()

/**
 * The address this identity's contract deploys to, derived from `C`.
 *
 * Bytes, because that is what the native builders take; `hex.encode` where an indexer query needs a
 * string. One representation stored, so the two cannot drift.
 */
export const identityContractAddressFor = async (c: Uint8Array): Promise<Uint8Array> => {
  const key = hex.encode(c)
  const known = addresses.get(key)
  if (known !== undefined) return known
  const keysDir = await ensureVerifierKeys('identity')
  const address = await identityAddress({keysDir, c})
  addresses.set(key, address)
  logger.debug('derived an identity contract address', {origin: ORIGIN, identity: key, address: hex.encode(address)})
  return address
}

/** The same, from a bech32m `pnyx_id` — which throws on a malformed or wrong-network value. */
export const identityContractAddressForPnyxId = async (pnyxId: string): Promise<Uint8Array> =>
  identityContractAddressFor(decodePnyxId(pnyxId).identity)

export type EnsureShellResult =
  /** Already on chain — the ordinary case for every identity after its first run. */
  | {readonly kind: 'deployed'; readonly address: Uint8Array}
  /** Relayed just now. The contract is not readable until it lands, so a caller must wait or retry. */
  | {readonly kind: 'submitted'; readonly address: Uint8Array}
  /** We could not find out whether it exists, so nothing was submitted. */
  | {readonly kind: 'unknown'; readonly address: Uint8Array; readonly reason: string}

/**
 * Make sure this identity's contract exists, deploying the shell if it does not.
 *
 * ⚠️ Never deploys on an *unreadable* indexer answer. A second deploy of the same identity is refused
 * on chain (`ContractAlreadyDeployed`, because the address is derived), so the cost of guessing wrong
 * is a wasted sponsored fee and a failure that reads like a bug — while doing nothing is recoverable
 * by the next retry.
 */
export const ensureIdentityShell = async (input: {
  readonly c: Uint8Array
  readonly networkId: string
  /** Absolute unix-second expiry of the deploy's intent, not a duration. */
  readonly expiresAtSecs: number
}): Promise<EnsureShellResult> => {
  const address = await identityContractAddressFor(input.c)
  const addressHex = hex.encode(address)
  const marker = await fetchContractMarker(addressHex)
  if (marker !== null) {
    logger.debug('identity contract already deployed', {origin: ORIGIN, address: addressHex, height: marker.height})
    return {kind: 'deployed', address}
  }
  // `fetchContractMarker` answers `null` for both "nothing there" and "could not ask", so the
  // distinction has to come from somewhere else: it logs its own failures, and an unreachable indexer
  // fails the deploy relay below anyway. What must not happen is treating a *readable* empty answer as
  // a reason to skip, which would leave a new identity permanently unpublishable.
  let deploy: {readonly address: Uint8Array; readonly tx: Uint8Array}
  try {
    const keysDir = await ensureVerifierKeys('identity')
    deploy = await buildIdentityDeployTx({
      keysDir,
      c: input.c,
      networkId: input.networkId,
      ttlSecs: input.expiresAtSecs,
    })
  } catch (error) {
    logger.warn('identity shell deploy could not be built', {origin: ORIGIN, address: addressHex, error: String(error)})
    return {kind: 'unknown', address, reason: `the deploy transaction could not be built: ${String(error)}`}
  }
  // The builder returns the address it will create; if that disagrees with the derivation the two
  // sides of this module have drifted, and publishing into the wrong contract is worse than failing.
  const built = hex.encode(deploy.address)
  if (built !== addressHex) {
    logger.error('identity deploy address disagrees with the derivation', {origin: ORIGIN, address: addressHex, built})
    return {kind: 'unknown', address, reason: 'the deploy would create a different contract than we derived'}
  }
  try {
    await relaySponsoredTx(deploy.tx)
  } catch (error) {
    logger.warn('identity shell deploy was not relayed', {origin: ORIGIN, address: addressHex, error: String(error)})
    return {kind: 'unknown', address, reason: String(error)}
  }
  logger.info('identity shell deploy relayed', {origin: ORIGIN, address: addressHex})
  return {kind: 'submitted', address}
}
