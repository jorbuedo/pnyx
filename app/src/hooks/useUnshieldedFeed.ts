/**
 * Keeping a wallet's live unshielded feed open for as long as something is rendering it.
 *
 * The feed is a fiber and a socket, so it needs an owner. This is that owner: mount starts it, unmount
 * stops it, and a wallet, account or network change stops the old one before starting the new. Several
 * screens asking for the same wallet share one feed — `startUnshieldedFeed` is keyed and returns
 * immediately when one is already up.
 *
 * ⚠️ **Starting is not the same as having data.** `caughtUp` is false until the replay reaches the id
 * the indexer named, and a partial history is not a short one. A caller rendering a list must say
 * "loading" until then rather than "nothing".
 *
 * @module
 */

import {Effect} from 'effect'
import {useEffect} from 'react'

import {logger} from '../logger'
import {useConfig, useWalletList} from '../providers'
import {midnightFundsNetwork} from '../services/midnight/networks'
import {
  feedKey,
  startUnshieldedFeed,
  stopUnshieldedFeed,
  type UnshieldedLive,
  unshieldedLive,
} from '../services/midnight/wallet/unshielded-live'
import {useKeyedServiceState} from './useServiceState'

const ORIGIN = 'unshielded-feed'

export type UnshieldedFeedState = {
  /** `undefined` until the feed has published anything for this wallet. */
  readonly live: UnshieldedLive | undefined
  /** The feed's key, or `undefined` when there is no wallet or no Midnight network to watch. */
  readonly key: string | undefined
}

/**
 * Watch `address` on the active Midnight funds network.
 *
 * `address` is optional because resolving it goes through the wallet service and measured ~7 s on a
 * cold start — the same reason the cache reads never waited for it. Passing `undefined` simply watches
 * nothing until it arrives.
 */
export const useUnshieldedFeed = (address: string | undefined): UnshieldedFeedState => {
  const {network} = useConfig()
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const groupId = selectedWalletGroup?.groupId
  const fundsNetwork = midnightFundsNetwork(network)
  const key =
    groupId === undefined || address === undefined || fundsNetwork === null
      ? undefined
      : feedKey(groupId, selectedAccountIndex, fundsNetwork)

  useEffect(() => {
    if (groupId === undefined || address === undefined || fundsNetwork === null || key === undefined) return
    Effect.runFork(
      startUnshieldedFeed({groupId, accountIndex: selectedAccountIndex, address, network: fundsNetwork}).pipe(
        Effect.catchTag('UnshieldedSyncError', (error) =>
          Effect.sync(() => {
            // `not-configured` is a build with no indexer for this network and no retry fixes it;
            // anything else is worth seeing. Either way the screen renders whatever it already had
            // rather than blanking, so the reason has to be on record or it is invisible.
            logger.warn('the unshielded feed could not be opened', {
              origin: ORIGIN,
              groupId,
              network: fundsNetwork,
              cause: error.cause,
              error: error.reason,
            })
          }),
        ),
      ),
    )
    // Stopping on unmount is what closes the socket. Several screens can share one feed, so this stops
    // the *key* — the last screen to leave takes it down, and an earlier one leaving restarts nothing
    // because `startUnshieldedFeed` is a no-op while the feed is up.
    return () => {
      Effect.runFork(stopUnshieldedFeed(key))
    }
  }, [address, fundsNetwork, groupId, key, selectedAccountIndex])

  return {live: useKeyedServiceState(unshieldedLive, key), key}
}
