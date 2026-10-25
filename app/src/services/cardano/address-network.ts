/**
 * Which network an address belongs to, read from the address itself.
 *
 * A Cardano bech32 address carries its network in its human-readable part —
 * `addr1…` is mainnet, `addr_test1…` is a testnet — so a payment request needs no
 * chain field to be placed. CIP-13 relies on exactly this.
 *
 * **The testnets are indistinguishable here and that is the point of the shape.**
 * Preprod and preview share `addr_test`, so the answer is a *family*, never a
 * specific network. Claiming more would be inventing a fact the address does not
 * carry, and the failure would be a silent switch to the wrong testnet.
 *
 * @module
 */

import type {CardanoNetwork} from '@pnyx/config'

/** The family an address belongs to, or `null` when it is not a Cardano address. */
export type AddressNetworkFamily = 'mainnet' | 'testnet'

export const addressNetworkFamily = (address: string): AddressNetworkFamily | null => {
  const trimmed = address.trim().toLowerCase()
  // `addr_test` first: `addr` is its prefix, so the order is load-bearing.
  if (trimmed.startsWith('addr_test1')) return 'testnet'
  if (trimmed.startsWith('addr1')) return 'mainnet'
  return null
}

/** The family the wallet is currently on. */
export const networkFamily = (network: CardanoNetwork): AddressNetworkFamily =>
  network === 'mainnet' ? 'mainnet' : 'testnet'

export type NetworkFit =
  /** The address belongs to the family we are on. Nothing to ask. */
  | {readonly kind: 'ok'}
  /**
   * The address is for the other family. `switchTo` is a *suggestion* the user
   * confirms — never applied for them, because changing networks changes which
   * wallet's funds are on screen.
   *
   * Switching to a testnet suggests preprod rather than preview: an address cannot
   * say which, and preprod is the one this app's rails and faucet are configured
   * for. Named in the copy so the user can see the guess and refuse it.
   */
  | {readonly kind: 'switch'; readonly switchTo: CardanoNetwork; readonly from: CardanoNetwork}
  /** Not a Cardano address at all — nothing to say about networks. */
  | {readonly kind: 'unknown'}

/**
 * Whether an address can be acted on from the network we are on, and what to offer
 * if not.
 *
 * Offering a switch beats refusing: a mainnet request while the wallet sits on
 * preprod is not a mistake by either party, and "wrong network" with no way
 * forward makes the user hunt through settings for something the app already knew.
 */
export const networkFitFor = (address: string, active: CardanoNetwork): NetworkFit => {
  const family = addressNetworkFamily(address)
  if (family === null) return {kind: 'unknown'}
  if (family === networkFamily(active)) return {kind: 'ok'}
  return {kind: 'switch', switchTo: family === 'mainnet' ? 'mainnet' : 'preprod', from: active}
}
