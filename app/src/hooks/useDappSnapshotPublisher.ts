/// <reference types="chrome" />
/**
 * Publishes the active Cardano account's CIP-30 read snapshot to
 * `chrome.storage.local` so the extension's background dApp router can answer
 * read methods without a live app window. Extension-only; a no-op on native and
 * plain web. Re-publishes on account change and on a slow interval so balances
 * stay reasonably fresh, and *clears* the snapshot whenever no account is active
 * so the worker can never answer a dApp with another wallet's addresses and
 * UTxOs. See `docs/EXTENSION.md`.
 *
 * @module
 */

import {Effect} from 'effect'
import {useEffect} from 'react'
import {DAPP_SNAPSHOT_KEY, type DappSnapshot} from '../../extension/dapp/protocol'
import {contextToSnapshot} from '../../extension/dapp/snapshot'
import {logger} from '../logger'
import {isExtension} from '../platform/extension/runtime'
import {useWalletAddress, useWalletList} from '../providers'
import {createCardanoHandlerContext, getCardanoRail, loadCardanoGovKeys} from '../services/cardano'

const REPUBLISH_INTERVAL_MS = 30_000

const hasStorage = (): boolean => typeof chrome !== 'undefined' && !!chrome.storage?.local

const writeSnapshot = (snapshot: DappSnapshot): Promise<void> =>
  new Promise((resolve) => {
    if (!hasStorage()) {
      resolve()
      return
    }
    chrome.storage.local.set({[DAPP_SNAPSHOT_KEY]: snapshot}, () => resolve())
  })

/** Drop the published snapshot so reads fail typed instead of serving stale data. */
const clearSnapshot = (): void => {
  if (!hasStorage()) return
  chrome.storage.local.remove(DAPP_SNAPSHOT_KEY, () => {})
}

/** Mount once in the root layout (alongside `useApprovalNavigation`). */
export function useDappSnapshotPublisher(): void {
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const {getDeriveOnlyAddresses} = useWalletAddress()
  const groupId = selectedWalletGroup?.groupId ?? null

  useEffect(() => {
    if (!isExtension) return
    if (groupId === null) {
      clearSnapshot()
      return
    }
    let cancelled = false

    const publish = async () => {
      try {
        const address = (await getDeriveOnlyAddresses()).cardano
        if (address === undefined) return clearSnapshot()
        const railHandle = getCardanoRail(groupId, address, undefined, {accountIndex: selectedAccountIndex})
        if (railHandle === null) return clearSnapshot()
        const rail = await railHandle
        const govKeys = await Effect.runPromise(loadCardanoGovKeys(groupId).pipe(Effect.orElseSucceed(() => null)))
        const context = createCardanoHandlerContext(
          rail,
          govKeys !== null ? {drepPubKeyHex: govKeys.drepPubKeyHex, stakePubKeyHex: govKeys.stakePubKeyHex} : undefined,
        )
        const snapshot = await contextToSnapshot(context, groupId, selectedAccountIndex)
        if (!cancelled) await writeSnapshot(snapshot)
      } catch (error) {
        // Best-effort — if publishing fails, the router reports reads unavailable. Logged anyway: a
        // dApp told "reads unavailable" with nothing on our side saying why is undiagnosable.
        logger.warn('could not publish the dapp snapshot; reads will report unavailable', {
          origin: 'dapp-snapshot-publisher',
          error: String(error),
        })
      }
    }

    void publish()
    const interval = setInterval(() => void publish(), REPUBLISH_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
      // The account this snapshot describes is no longer the active one.
      clearSnapshot()
    }
  }, [groupId, selectedAccountIndex, getDeriveOnlyAddresses])
}
