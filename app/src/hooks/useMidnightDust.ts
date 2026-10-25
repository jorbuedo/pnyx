/**
 * This wallet's own DUST — the Midnight-native side of DUST generation.
 *
 * ⚠️ **Two different things are both called "DUST generation", and this is the second one.** The
 * Cardano path registers **cNIGHT held on Cardano** to a DUST address, and the indexer computes its
 * capacity server-side (`services/midnight-dust`), which is why that screen never needed a sync. This
 * one is **NIGHT held on Midnight**: its DUST lives in a local `DustLocalState`, and the spendable
 * amount at any instant is the generation model run over it — arithmetic the indexer does not do for
 * this path. Conflating the two produces a number that looks plausible and is not a balance.
 *
 * Reads the **stored** state only. Syncing takes tens of seconds, so it is an action a caller triggers,
 * never a side effect of mounting a screen.
 *
 * @module
 */

import {spendableDustAt} from '@pnyx/midnight-native'
import {Effect} from 'effect'
import {useCallback, useEffect, useState} from 'react'

import {logger} from '../logger'
import {useConfig, useWalletList} from '../providers'
import {type DustStaleness, dustStaleness} from '../services/midnight/dust-staleness'
import {runMidnight} from '../services/midnight/effect-boundary'
import {midnightFundsNetwork} from '../services/midnight/networks'
import {
  isDustStateFresh,
  loadDustBlockTime,
  loadDustState,
  loadDustSyncedAt,
  loadDustSyncedWatermark,
} from '../services/midnight/wallet/dust-state-store'
import {loadUnshieldedCache} from '../services/midnight/wallet/unshielded-store'
import {onStoreChange} from '../services/store-change'

const ORIGIN = 'useMidnightDust'

/** How old a synced state may be and still be treated as current. */
export const DUST_FRESH_FOR_SECS = 15 * 60

export type MidnightDust = {
  /**
   * Spendable DUST in SPECK, or `null` when no state has been synced.
   *
   * `null` is **not zero**. "Nobody has looked" and "this wallet holds none" justify different copy and
   * different actions, and only one of them means a self-funded send cannot happen.
   */
  readonly balance: bigint | null
  /** How many DUST outputs the state holds. */
  readonly utxos: number
  /** Unix seconds of the last successful sync, or `null`. */
  readonly syncedAt: number | null
  /**
   * Whether {@link syncedAt} is inside {@link DUST_FRESH_FOR_SECS}.
   *
   * ⚠️ A **spend** guard, not a display one: it asks "is this state recent enough to take an output
   * from", where age is a blunt but conservative proxy for an output spent somewhere this wallet did
   * not see. For "would re-syncing find anything", use {@link staleness} — age answers that badly,
   * because the balance is recomputed against the clock on every read and stays right regardless.
   */
  readonly fresh: boolean
  /** Whether a re-sync would find anything — see `services/midnight/dust-staleness.ts`. */
  readonly staleness: DustStaleness
  /**
   * The block time the stored state's roots belong to, or `null` when none was recorded.
   *
   * ⚠️ Exposed because it, and not the balance or the staleness, is what decides whether this state can
   * pay a fee — `services/midnight/fee-payer.ts`. `null` and `0` both mean it cannot.
   */
  readonly blockTimeSecs: number | null
  readonly loading: boolean
  /** Re-read the stored state. Does **not** sync — see the module note. */
  readonly reload: () => void
}

export const useMidnightDust = (): MidnightDust => {
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const {network} = useConfig()
  const fundsNetwork = midnightFundsNetwork(network)
  const groupId = selectedWalletGroup?.groupId
  const [state, setState] = useState<{
    balance: bigint | null
    utxos: number
    syncedAt: number | null
    staleness: DustStaleness
    blockTimeSecs: number | null
  }>({balance: null, utxos: 0, syncedAt: null, staleness: 'never', blockTimeSecs: null})
  const [loading, setLoading] = useState(true)

  /**
   * Read the stored state and price it at now.
   *
   * One function for both the mount and an explicit reload, rather than an effect keyed on a counter:
   * the counter read as a redundant dependency to anything that could not see it was the trigger.
   */
  const load = useCallback(
    async (isLive: () => boolean): Promise<void> => {
      if (groupId === undefined || fundsNetwork === null) {
        setLoading(false)
        return
      }
      setLoading(true)
      try {
        // `concurrency: 'unbounded'` because `Effect.all` is sequential by default and these five are
        // independent reads — the `Promise.all` this replaced ran them together.
        const [stored, syncedAt, dustWatermark, unshielded, blockTime] = await runMidnight(
          Effect.all(
            [
              loadDustState(groupId, selectedAccountIndex, fundsNetwork),
              loadDustSyncedAt(groupId, selectedAccountIndex),
              loadDustSyncedWatermark(groupId, selectedAccountIndex),
              loadUnshieldedCache(groupId, selectedAccountIndex),
              loadDustBlockTime(groupId, selectedAccountIndex),
            ],
            {concurrency: 'unbounded'},
          ),
        )
        if (!isLive()) return
        const staleness = dustStaleness({
          dustSyncedAt: syncedAt,
          dustWatermark,
          unshieldedWatermark: unshielded?.transactionId,
        })
        if (stored === undefined) {
          // Worth logging: "never synced" and "holds none" are different facts, rendered differently.
          logger.debug('no stored dust state for this wallet', {origin: ORIGIN, groupId})
          setState({balance: null, utxos: 0, syncedAt: syncedAt ?? null, staleness, blockTimeSecs: null})
          return
        }
        const read = await spendableDustAt(stored, BigInt(Math.floor(Date.now() / 1000)))
        if (!isLive()) return
        logger.debug('read the stored dust state', {
          origin: ORIGIN,
          groupId,
          utxos: read.utxos,
          staleness,
          dustWatermark: dustWatermark ?? null,
          unshieldedWatermark: unshielded?.transactionId ?? null,
          // Logged because it is the difference between a state that can pay a fee and one that cannot,
          // and it is invisible in the balance: `0` reads as a perfectly healthy sync.
          blockTime: blockTime ?? null,
        })
        setState({
          balance: read.balance,
          utxos: read.utxos,
          syncedAt: syncedAt ?? null,
          staleness,
          blockTimeSecs: blockTime ?? null,
        })
      } catch (error) {
        if (!isLive()) return
        // A read failure is not "no DUST"; leaving the balance null keeps the two apart on screen.
        logger.warn('the stored dust state could not be read', {
          origin: ORIGIN,
          groupId,
          error: error instanceof Error ? error.message : String(error),
        })
        setState({balance: null, utxos: 0, syncedAt: null, staleness: 'never', blockTimeSecs: null})
      } finally {
        if (isLive()) setLoading(false)
      }
    },
    [groupId, selectedAccountIndex, fundsNetwork],
  )

  const reload = useCallback(() => {
    void load(() => true)
  }, [load])

  useEffect(() => {
    let live = true
    void load(() => live)
    // A sync, a send or a registration writes this store from a service, and a screen that read on
    // mount would otherwise show the old figure until it remounted — which is why restarting the app
    // has been the way to make these numbers agree.
    const unsubscribe = onStoreChange('midnight-dust', () => {
      void load(() => live)
    })
    return () => {
      live = false
      unsubscribe()
    }
  }, [load])

  return {
    balance: state.balance,
    utxos: state.utxos,
    syncedAt: state.syncedAt,
    fresh: isDustStateFresh(state.syncedAt ?? undefined, Math.floor(Date.now() / 1000), DUST_FRESH_FOR_SECS),
    staleness: state.staleness,
    blockTimeSecs: state.blockTimeSecs,
    loading,
    reload,
  }
}
