/**
 * How far behind the chain this wallet's shielded scan is.
 *
 * ⚠️ **"No shielded coins found" and "we have not looked yet" render identically, and they are not the
 * same claim** (plan item 62(d)). The shielded rail is deliberately excluded from the background
 * scheduler — the Zswap role key *spends*, and no viewing-only form exists, so a scheduler holding it
 * would be holding a spending key — which means a wallet drifts behind the chain the moment it is left
 * alone. Without this the drift is invisible, and an absent coin reads as a coin that is not there.
 *
 * **One request.** The cursor is local and the tip is a single GraphQL read; the verdict is
 * `shielded-freshness`'s, the same rule that decides whether a shielded transfer may be built, so the
 * sentence on screen and the refusal at build time can never disagree.
 *
 * @module
 */

import {useCallback, useEffect, useState} from 'react'

import {logger} from '../logger'
import {useConfig, useWalletList} from '../providers'
import {runMidnight} from '../services/midnight/effect-boundary'
import {midnightFundsNetwork} from '../services/midnight/networks'
import {type ShieldedFreshness, shieldedFreshness} from '../services/midnight/wallet/shielded-freshness'
import {fetchTipHeight} from '../services/midnight/wallet/shielded-sync'
import {loadShieldedBirthday, loadShieldedCursor} from '../services/midnight/wallet/state-store'
import type {ShieldedBirthday} from '../services/midnight/wallet/sync-window'
import {onStoreChange} from '../services/store-change'

const ORIGIN = 'shielded-freshness'

export type ShieldedFreshnessState = {
  /** `null` until the first read finishes, or when there is no wallet or network to read for. */
  readonly freshness: ShieldedFreshness | null
  /**
   * Where this wallet's history starts, or `undefined` when nothing records it.
   *
   * ⚠️ **`undefined` is the case a screen has to act on** (plan item 62(c)): a wallet created before
   * birthdays existed scans a window below the tip, so a coin older than that window is invisible and
   * nothing on screen would say so. It cannot be filled in by the app — only its owner knows whether
   * the seed predates the day it was added here.
   */
  readonly birthday: ShieldedBirthday | undefined
  readonly refresh: () => void
}

export const useShieldedFreshness = (): ShieldedFreshnessState => {
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const {network} = useConfig()
  const fundsNetwork = midnightFundsNetwork(network)
  const groupId = selectedWalletGroup?.groupId ?? null
  const [state, setState] = useState<{
    freshness: ShieldedFreshness | null
    birthday: ShieldedBirthday | undefined
  }>({freshness: null, birthday: undefined})

  const read = useCallback(async () => {
    if (groupId === null || fundsNetwork === null) {
      setState({freshness: null, birthday: undefined})
      return
    }
    const cursor = await runMidnight(loadShieldedCursor(groupId, selectedAccountIndex, fundsNetwork)).catch(
      (error: unknown) => {
        // A cursor that cannot be read is not the same as one that is absent, and treating it as absent
        // would say "never scanned" about a wallet that has. Reported, then handled as unknown.
        logger.warn('could not read the shielded cursor', {origin: ORIGIN, groupId, error: String(error)})
        return undefined
      },
    )
    const tip = await runMidnight(fetchTipHeight(fundsNetwork)).catch((error: unknown) => {
      logger.debug('could not read the chain tip for shielded freshness', {
        origin: ORIGIN,
        network: fundsNetwork,
        error: String(error),
      })
      return null
    })
    const birthday = await runMidnight(loadShieldedBirthday(groupId, fundsNetwork)).catch((error: unknown) => {
      logger.warn('could not read the shielded birthday', {origin: ORIGIN, groupId, error: String(error)})
      return undefined
    })
    setState({freshness: shieldedFreshness({cursor, tip}), birthday})
  }, [groupId, selectedAccountIndex, fundsNetwork])

  useEffect(() => {
    void read()
    // A sync writes the cursor, so the line updates itself rather than waiting for the screen to be
    // revisited — the same signal `useMidnightShieldedBalance` listens on.
    return onStoreChange('midnight-shielded', () => {
      void read()
    })
  }, [read])

  return {...state, refresh: () => void read()}
}
