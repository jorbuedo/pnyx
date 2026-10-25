/**
 * Run a shielded sync for the selected funds group.
 *
 * ⚠️ **This prompts for biometrics**, because discovering a coin means decrypting output ciphertexts and
 * that needs the role key — so it must be user-initiated, never a background refresh. Reading a balance is
 * the free half (`useMidnightShieldedBalance`).
 *
 * The mnemonic is fetched, used, and dropped inside one call; nothing here holds it across renders.
 *
 * @module
 */

import {useCallback, useRef, useState} from 'react'
import {logger} from '../logger'
import {useConfig, useI18n, useWalletAddress, useWalletList} from '../providers'
import {runMidnight} from '../services/midnight/effect-boundary'
import {midnightFundsNetwork} from '../services/midnight/networks'
import {type ShieldedSyncOutcome, type ShieldedSyncProgress, syncShieldedWallet} from '../services/midnight/wallet/sync'

const ORIGIN = 'midnight-sync'

export type MidnightSyncState = {
  readonly syncing: boolean
  /**
   * How far the walk in progress has got, or `null` when nothing is running.
   *
   * ⚠️ **A shielded sync is not a refresh, it is a walk**, and one that starts at a birthday far back
   * takes minutes. A spinner for that is indistinguishable from a hang, which is why this exists
   * rather than being derived from `syncing` alone.
   */
  readonly progress: ShieldedSyncProgress | null
  /** Stops the walk between windows. Everything already scanned stays saved. */
  readonly cancel: () => void
  /** The last run's outcome, or `null` before the first one. */
  readonly last: ShieldedSyncOutcome | null
  /**
   * Why the last attempt could not run, or `null`. Separate from `last` because "no Midnight endpoint for
   * this network" and "synced nothing" are different answers and a caller may say so.
   */
  readonly unavailable: string | null
  readonly sync: () => Promise<void>
}

export const useMidnightSync = (): MidnightSyncState => {
  const {t} = useI18n()
  const {network} = useConfig()
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const {ensureMidnightReceiveAddresses} = useWalletAddress()
  const [state, setState] = useState<{
    syncing: boolean
    progress: ShieldedSyncProgress | null
    last: ShieldedSyncOutcome | null
    unavailable: string | null
  }>({
    syncing: false,
    progress: null,
    last: null,
    unavailable: null,
  })
  // A ref, not state: it is read inside a running walk, and a state value captured at the start of one
  // would stay `false` however many times the button was pressed.
  const cancelled = useRef(false)

  const cancel = useCallback(() => {
    cancelled.current = true
    logger.info('shielded sync cancelled by the user', {origin: ORIGIN})
  }, [])

  const sync = useCallback(async () => {
    const groupId = selectedWalletGroup?.groupId
    if (groupId === undefined) return
    const midnightNetwork = midnightFundsNetwork(network)
    if (midnightNetwork === null) {
      setState({syncing: false, progress: null, last: null, unavailable: `no Midnight endpoint for ${network}`})
      return
    }

    cancelled.current = false
    setState((prev) => ({...prev, syncing: true, progress: null, unavailable: null}))
    try {
      // Imported here rather than at module scope: the vault pulls native keychain bindings, and this
      // screen renders on platforms and in tests that never sync.
      const {createEnclaveMnemonicVault} = await import('../services/credential-vault')
      const {Effect} = await import('effect')
      const mnemonic = await Effect.runPromise(
        createEnclaveMnemonicVault().retrieve(groupId, t('common.biometricPrompt')),
      )
      // Repair before syncing: this is the one place a mnemonic is already in hand,
      // so a wallet whose Midnight rows predate network keying gets its missing
      // networks written here rather than prompting for the seed again. Idempotent.
      // ⚠️ **The selected account, not the default.** Omitting it fell through to `?? 0`, so on any
      // other account the repair wrote account 0's rows and the account actually in use still had no
      // address — a Receive screen with nothing on it, and a sync with no address to read.
      const written = await ensureMidnightReceiveAddresses({
        groupId,
        mnemonic,
        accountIndex: selectedAccountIndex,
      }).catch((error: unknown) => {
        // Not fatal to the sync: a missing receive row costs the Receive screen, not
        // this read. Logged because a silent skip is indistinguishable from a repair
        // that never ran.
        logger.warn('could not ensure Midnight receive addresses', {origin: ORIGIN, groupId, error: String(error)})
        return [] as readonly string[]
      })
      if (written.length > 0) {
        logger.info('backfilled Midnight receive addresses', {origin: ORIGIN, groupId, networks: written.join(',')})
      }
      const outcome = await runMidnight(
        syncShieldedWallet({
          groupId,
          accountIndex: selectedAccountIndex,
          mnemonic,
          network: midnightNetwork,
          onProgress: (progress) => setState((prev) => ({...prev, progress})),
          shouldContinue: () => !cancelled.current,
        }),
      )
      setState({
        syncing: false,
        progress: null,
        last: outcome,
        unavailable: outcome === null ? `no Midnight endpoint for ${network}` : null,
      })
    } catch (error) {
      // A declined biometric prompt lands here too, which is why this is not an error state in the UI —
      // the user simply did not authorise a read of their seed.
      logger.warn('shielded sync did not complete', {origin: ORIGIN, groupId, error: String(error)})
      setState({syncing: false, progress: null, last: null, unavailable: null})
    }
  }, [ensureMidnightReceiveAddresses, network, selectedAccountIndex, selectedWalletGroup?.groupId, t])

  return {...state, sync, cancel}
}
