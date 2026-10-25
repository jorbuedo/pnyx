/**
 * Whether any shared (multisig) wallet is registered on the active network.
 * Drives the co-sign entry points (Wallets-home pending card, Send screen link)
 * that must stay reachable even when nothing is pending yet. Re-reads on screen
 * focus so the affordances appear right after a wallet is created.
 *
 * Scoped to the active network on purpose: the registry used to be keyed by
 * script address alone, so a preprod wallet lit these entry points up on
 * mainnet.
 *
 * @module
 */

import {Effect} from 'effect'
import {useFocusEffect} from 'expo-router'
import {useCallback, useState} from 'react'
import {logger} from '../logger'
import {getActiveCardanoNetwork} from '../services/cardano/config'
import {addressNetworkOf, platformSharedWalletRegistry} from '../services/cardano/multisig'

export const useHasMultisigWallets = (): boolean => {
  const [has, setHas] = useState(false)

  useFocusEffect(
    useCallback(() => {
      let active = true
      const network = addressNetworkOf(getActiveCardanoNetwork())
      void Effect.runPromise(platformSharedWalletRegistry().list(network))
        .then((wallets) => {
          if (active) setHas(wallets.length > 0)
        })
        .catch((e) => {
          logger.warn('Shared wallet registry read failed; reporting none', {
            origin: 'useHasMultisigWallets',
            error: String(e),
          })
          if (active) setHas(false)
        })
      return () => {
        active = false
      }
    }, []),
  )

  return has
}
