/**
 * Shared wallet selection hook.
 *
 * Used by both WalletProvider and ExtensionWalletProvider to ensure
 * identical selection semantics across all platforms.
 *
 * @module
 */

import {useCallback, useEffect, useRef, useState} from 'react'
import {logger} from '../logger'
import {storage} from '../platform/storage'
import {dispatchSelectionIntent, resolveSelectionIntent, type WalletSelectionHandlers} from '../utils/wallet-selection'
import {useLatestRef} from './useLatestRef'

const LAST_GROUP_KEY = '@pnyx/wallet/lastGroupId'

/**
 * Shared wallet selection hook.
 *
 * Owns the intent resolution, the dispatch, and lastGroupId management.
 * Persists the selected group ID to platform storage so it survives app reloads.
 * Providers only supply two callbacks: `persistGroup` and `persistChain`.
 *
 * @returns `selectWallet` callback, `selectAllBlockchains` shortcut, and `lastGroupId` state
 */
export function useWalletSelection(handlers: WalletSelectionHandlers) {
  const handlersRef = useLatestRef(handlers)

  // Restore persisted group ID synchronously where possible (MMKV, localStorage)
  // to avoid a render cycle where selectedWalletGroup resolves to the wrong group.
  // On extension (chrome.storage), falls back to async restore.
  const [lastGroupId, setLastGroupId] = useState<string | null>(() => storage.getSync(LAST_GROUP_KEY))
  const lastGroupIdRef = useRef<string | null>(lastGroupId)

  const updateLastGroupId = useCallback((groupId: string | null) => {
    lastGroupIdRef.current = groupId
    setLastGroupId(groupId)
    if (groupId) {
      storage.set(LAST_GROUP_KEY, groupId).catch((e) => {
        logger.warn('Failed to persist the last selected wallet', {
          origin: 'useWalletSelection',
          groupId,
          error: String(e),
        })
      })
    }
  }, [])

  // Async fallback for extension where getSync returns null
  useEffect(() => {
    if (lastGroupIdRef.current) return
    storage.get(LAST_GROUP_KEY).then((value) => {
      if (value && !lastGroupIdRef.current) {
        lastGroupIdRef.current = value
        setLastGroupId(value)
      }
    })
  }, [])

  const selectWallet = useCallback(
    async (groupId: string | null) => {
      const intent = resolveSelectionIntent(groupId)
      switch (intent.type) {
        case 'deselect':
          logger.info('Deselecting wallet (All Blockchains view)', {origin: 'useWalletSelection'})
          break
        case 'select-group':
          logger.info('Selecting wallet group', {origin: 'useWalletSelection', groupId: intent.groupId})
          break
      }
      await dispatchSelectionIntent(intent, handlersRef.current, updateLastGroupId)
    },
    [updateLastGroupId],
  )

  const selectAllBlockchains = useCallback(() => selectWallet(null), [selectWallet])

  return {selectWallet, selectAllBlockchains, lastGroupId}
}
