/**
 * Which rail a recipient belongs to, read from the recipient itself.
 *
 * The send flow was written when there was one funds chain. Midnight is now a second, with two rails
 * of its own — unshielded (`mn_addr…`) and shielded (`mn_shield-addr…`) — and an address says which
 * it is, so nothing needs to be asked or configured. Cardano's own `addr…` / `name.ada` / `$handle`
 * shapes stay where they are: this decides *whose* resolution runs, not what a Cardano address means.
 *
 * A DUST address (`mn_dust…`) is deliberately **not** a destination. It is where generated DUST is
 * delivered and the value a cNIGHT→DUST registration datum carries; paying it is a category error, and
 * one worth naming rather than reporting as an invalid address.
 *
 * Pure and its own module so the decision is testable without the send screen's context chain.
 *
 * @module
 */

import {parseMidnightAddress} from '@pnyx/wallet'
import {midnightFundsNetwork} from '../midnight/networks'

export type SendRoute =
  /**
   * Not a Midnight address. Cardano's resolution decides whether it is an address, a handle, a CNS
   * name or nothing — this module deliberately does not second-guess it.
   */
  | {readonly rail: 'cardano'}
  | {
      readonly rail: 'midnight'
      readonly kind: 'unshielded' | 'shielded'
      /** The network the address itself names — `mainnet` when its HRP carries no segment. */
      readonly network: string
      /**
       * Whether that is the Midnight network this wallet is reading. False is not a typo by anyone:
       * a mainnet address pasted on preprod is a well-formed address for another chain, and saying
       * "invalid address" would send the user hunting for a character that is not wrong.
       */
      readonly onOurNetwork: boolean
    }
  | {
      readonly rail: 'unusable'
      readonly reason: /** `mn_dust…` — receives generated DUST, cannot be paid. */
        | 'dust-address'
        /** bech32m checksum failed: the prefix is ours, so a character is missing or changed. */
        | 'damaged-midnight'
        /** An `mn_` type this build does not know — a newer address form, not a mistake. */
        | 'unknown-midnight-type'
    }

/**
 * Route a recipient input for the wallet's current (Cardano-named) network.
 *
 * `appNetwork` is the app's network name; the Midnight network it implies comes from
 * `midnightFundsNetwork`, which answers `null` for networks with no Midnight pairing (preview). A
 * `null` there means no Midnight address can be on our network, which is the honest answer — not a
 * reason to treat the address as Cardano's problem.
 */
export const routeRecipient = (input: string, appNetwork: string | null): SendRoute => {
  const parsed = parseMidnightAddress(input)
  if (!parsed.ok) {
    switch (parsed.reason) {
      case 'not-midnight':
        return {rail: 'cardano'}
      case 'malformed':
        return {rail: 'unusable', reason: 'damaged-midnight'}
      case 'unknown-type':
        return {rail: 'unusable', reason: 'unknown-midnight-type'}
    }
  }
  if (parsed.kind === 'dust') return {rail: 'unusable', reason: 'dust-address'}
  return {
    rail: 'midnight',
    kind: parsed.kind === 'shielded' ? 'shielded' : 'unshielded',
    network: parsed.network,
    onOurNetwork: parsed.network === midnightFundsNetwork(appNetwork),
  }
}
