/**
 * Whether a shared wallet is registered on the *active* Cardano network.
 *
 * Wallet groups are not network-scoped; the shared-wallet registry is. So a
 * wallet created on mainnet still appears in the preprod wallet list, where its
 * roster cannot be read, no script can be compiled from it, and the rail fails
 * with `not-registered`. This is the read that lets a row say so.
 *
 * A single keyed `get`, not a `list`: the group id *is* the shared wallet's id, so
 * one lookup answers it, and the hook is called once per row.
 *
 * @module
 */

import {Effect} from 'effect'
import {useEffect, useState} from 'react'
import {logger} from '../logger'
import {getActiveCardanoNetwork, onCardanoNetworkChange} from '../services/cardano/config'
import {addressNetworkOf, platformSharedWalletRegistry} from '../services/cardano/multisig'

/**
 * `true` registered here, `false` registered on the other network (or gone),
 * `undefined` while the read is outstanding or the wallet is not a shared one.
 *
 * `undefined` on failure too, deliberately: a storage read that did not happen is
 * not evidence a wallet belongs to another network, and labelling it as such would
 * be a guess about the one thing the label exists to state.
 */
export const useSharedWalletOnNetwork = (groupId: string | null, isShared: boolean): boolean | undefined => {
  const [registered, setRegistered] = useState<boolean | undefined>(undefined)
  // Re-read on a network switch, which is the whole scenario this label serves:
  // the answer is a property of the *active* network, not of the wallet.
  const [networkNonce, setNetworkNonce] = useState(0)
  useEffect(() => onCardanoNetworkChange(() => setNetworkNonce((n) => n + 1)), [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: `networkNonce` re-runs the read, it is not read
  useEffect(() => {
    if (!isShared || groupId === null) {
      setRegistered(undefined)
      return
    }
    let active = true
    const network = addressNetworkOf(getActiveCardanoNetwork())
    void Effect.runPromise(platformSharedWalletRegistry().get(network, groupId))
      .then((wallet) => {
        if (active) setRegistered(wallet !== null)
      })
      .catch((e: unknown) => {
        logger.warn('Shared wallet registry lookup failed', {
          origin: 'useSharedWalletOnNetwork',
          groupId,
          message: String(e),
        })
        if (active) setRegistered(undefined)
      })
    return () => {
      active = false
    }
  }, [groupId, isShared, networkNonce])

  return registered
}
