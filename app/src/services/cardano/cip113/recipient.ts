/**
 * Where a programmable token actually goes when you send it to someone.
 *
 * ⚠️ **Not to the address the user typed.** A CIP-113 token can only exist at an address whose
 * payment credential is the deployment's script, so a transfer to `addr1…` lands at the smart
 * wallet derived from *that address's stake credential*. The typed address is how we find the
 * recipient; it is not where the tokens sit afterwards.
 *
 * Three things follow, and each is a refusal rather than a warning:
 *
 * - **An address with no stake credential cannot receive one at all.** An enterprise address has no
 *   stake half to pair with the script, so there is no smart wallet to send to and there is no
 *   approximation worth offering. Refused before the user reaches an amount.
 * - **Sending to an address is sending to an account.** Every address sharing that stake credential
 *   resolves to the same smart wallet, so "which of my addresses" is not a question this has. Worth
 *   saying on the review, because it differs from every other send.
 * - **The review must show the destination we computed**, not the address that was typed. Showing
 *   the typed one would state that the tokens went somewhere they did not.
 *
 * @module
 */

import type {Cip113, Deployment as Cip113Deployment} from '@evolution-sdk/cip113'
import {Bech32} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {logger} from '../../../logger'

export type ProgrammableRecipient =
  | {
      readonly kind: 'resolved'
      /** What the user typed. Kept so the UI can show both, never just this one. */
      readonly typedAddressBech32: string
      /** Where the tokens will actually be. PLB payment credential + the recipient's stake half. */
      readonly smartWalletBech32: string
      /** The owner the transfer names — the recipient's stake credential, key or script. */
      readonly owner: Cip113.Credential
      /**
       * True when the recipient's stake credential is a script (a shared wallet, say).
       *
       * Not refused — the protocol keys ownership on the credential, not on its kind — but worth
       * surfacing: the holder of that token will be whoever can satisfy that script.
       */
      readonly ownerIsScript: boolean
    }
  | {readonly kind: 'refused'; readonly reason: ProgrammableRecipientRefusal; readonly detail: string}

export type ProgrammableRecipientRefusal =
  /** No stake credential: an enterprise address has no smart wallet, and never will. */
  | 'no-stake-credential'
  /** The address did not decode, or is not one this network uses. */
  | 'unreadable-address'
  /** The address is for another network. */
  | 'wrong-network'

/**
 * Resolve a typed recipient address to the smart wallet a transfer would reach.
 *
 * `ourNetworkId` is Cardano's (0 testnet / 1 mainnet), checked here rather than left to the build:
 * a transfer is expensive to assemble and a network mismatch is knowable from the address alone.
 */
export const resolveProgrammableRecipient = (
  typedAddressBech32: string,
  deployment: Cip113Deployment.Cip113Deployment,
  ourNetworkId: number,
): ProgrammableRecipient => {
  let info: Address.AddressInfo
  try {
    info = Address.inspect(Address.fromBech32Sync(Bech32(typedAddressBech32.trim())))
  } catch (e: unknown) {
    // The refusal reaches the user, but not which part of the address defeated us.
    logger.debug('Programmable-token recipient address could not be read', {
      origin: 'cip113/recipient',
      error: String(e),
    })
    return {kind: 'refused', reason: 'unreadable-address', detail: 'that address could not be read'}
  }

  if (info.networkId !== ourNetworkId) {
    return {
      kind: 'refused',
      reason: 'wrong-network',
      detail: `that address is on network ${info.networkId}, this wallet is on ${ourNetworkId}`,
    }
  }

  const stakeCredHex = info.stakeCredHex
  if (stakeCredHex === undefined) {
    return {
      kind: 'refused',
      reason: 'no-stake-credential',
      detail: 'that address has no staking part, so it cannot hold a programmable token',
    }
  }

  const ownerIsScript = info.stakeIsScript === true
  const smartWalletHex = Address.baseScriptHex(
    info.networkId === 1 ? Address.Network.Mainnet : Address.Network.Testnet,
    deployment.plbScriptHashHex,
    stakeCredHex,
  )
  return {
    kind: 'resolved',
    typedAddressBech32,
    smartWalletBech32: Address.toBech32Sync(smartWalletHex),
    owner: {kind: ownerIsScript ? 'script' : 'key', hashHex: stakeCredHex},
    ownerIsScript,
  }
}
