/**
 * Hook to track mnemonic backup pending status per wallet group.
 *
 * Uses a React Context provider so all settings screens share a single
 * source of truth — the same pattern as WalletProvider's renameWallet.
 * When confirm() updates context state, every consumer re-renders.
 *
 * Only Quick Start wallets write the pending flag. All other creation paths
 * (full create with verification, restore, social login) never write it.
 * Verification removes the flag.
 *
 * @module
 */

import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {storage} from '../platform/storage'

export const storageKey = (groupId: string) => `@pnyx/mnemonic-backup-pending:${groupId}`

type BackupStatusState = {
  statusByGroup: Map<string, boolean>
  loadGroup: (groupId: string) => void
  confirmGroup: (groupId: string) => Promise<void>
  markGroupPending: (groupId: string) => Promise<void>
}

export const BackupStatusContext = createContext<BackupStatusState | null>(null)

export function BackupStatusProvider({children}: {children: ReactNode}) {
  const [statusByGroup, setStatusByGroup] = useState<Map<string, boolean>>(() => new Map())
  const loadedGroupsRef = useRef<Set<string>>(new Set())

  const loadGroup = useCallback((groupId: string) => {
    if (loadedGroupsRef.current.has(groupId)) return
    loadedGroupsRef.current.add(groupId)
    storage.get(storageKey(groupId)).then((value) => {
      setStatusByGroup((prev) => {
        const next = new Map(prev)
        next.set(groupId, value === 'true')
        return next
      })
    })
  }, [])

  const confirmGroup = useCallback(async (groupId: string) => {
    await storage.remove(storageKey(groupId))
    setStatusByGroup((prev) => {
      const next = new Map(prev)
      next.set(groupId, false)
      return next
    })
  }, [])

  // Writes the pending flag to storage and directly updates in-memory state,
  // bypassing the async loadGroup read. Also marks the groupId as loaded so
  // a subsequent loadGroup call does not overwrite the state with a stale read.
  const markGroupPending = useCallback(async (groupId: string) => {
    await storage.set(storageKey(groupId), 'true')
    loadedGroupsRef.current.add(groupId)
    setStatusByGroup((prev) => {
      const next = new Map(prev)
      next.set(groupId, true)
      return next
    })
  }, [])

  const value = useMemo(
    () => ({statusByGroup, loadGroup, confirmGroup, markGroupPending}),
    [statusByGroup, loadGroup, confirmGroup, markGroupPending],
  )
  return createElement(BackupStatusContext.Provider, {value}, children)
}

export function useMnemonicBackupStatus(groupId: string | undefined) {
  const ctx = useContext(BackupStatusContext)
  if (!ctx) throw new Error('useMnemonicBackupStatus must be used within BackupStatusProvider')

  const {statusByGroup, loadGroup, confirmGroup} = ctx

  useEffect(() => {
    if (groupId) loadGroup(groupId)
  }, [groupId, loadGroup])

  const isPending: boolean | null = groupId ? (statusByGroup.get(groupId) ?? null) : null

  const confirm = useCallback(async () => {
    if (!groupId) return
    await confirmGroup(groupId)
  }, [groupId, confirmGroup])

  return {isPending, confirm}
}

export function useMarkMnemonicBackupPending() {
  const ctx = useContext(BackupStatusContext)
  if (!ctx) throw new Error('useMarkMnemonicBackupPending must be used within BackupStatusProvider')
  return ctx.markGroupPending
}
