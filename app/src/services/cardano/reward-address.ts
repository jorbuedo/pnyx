/**
 * Derive the reward (stake) address a Cardano address delegates through, from
 * its stake credential. Pure — bech32 over the CIP-19 header, no network.
 *
 * @module
 */

import {Address} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {logger} from '../../logger'

/**
 * `stake1…` for a stake credential, or `undefined` when it cannot be derived —
 * an unknown network id, a malformed hash. A wrong reward address would point
 * the reader at someone else's stake account, so absence is the only safe miss.
 */
export const rewardAddressFor = (
  networkId: number,
  stake: {readonly hashHex: string; readonly type: 'key' | 'script'},
): string | undefined => {
  if (networkId !== Address.Network.Mainnet && networkId !== Address.Network.Testnet) return undefined
  try {
    const hex =
      stake.type === 'script'
        ? Address.rewardScriptHex(networkId, stake.hashHex)
        : Address.rewardHex(networkId, stake.hashHex)
    return Effect.runSync(Address.toBech32(hex))
  } catch (e: unknown) {
    // `undefined` reads as "this wallet has no reward address", which is what a wallet with no
    // stake credential looks like — and it is what staking and DUST both key on.
    logger.warn('Reward address could not be derived', {origin: 'cardano/reward-address', error: String(e)})
    return undefined
  }
}
