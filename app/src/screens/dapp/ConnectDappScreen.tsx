/**
 * Extension connect-approval screen. The background dApp router broadcasts
 * `NAVIGATE_CONNECT_DAPP` (handled by `useApprovalNavigation`) which routes here
 * with the requesting `origin`; the user's decision is sent back to the router,
 * which then grants the session and resolves the dApp's `enable()`.
 *
 * @module
 */

import {useLocalSearchParams, useRouter} from 'expo-router'
import {useState} from 'react'
import {DappConnectSheet} from '../../components/DappBrowser/DappConnectSheet'
import {isExtensionApprovalPopup} from '../../platform/extension/runtime'
import {closePopup} from '../../platform/extension/surfaces'
import {useWalletList} from '../../providers'
import {sendConnectDecision} from '../../services/dapp/extension-approval'

export function ConnectDappScreen() {
  const {origin} = useLocalSearchParams<{origin?: string}>()
  const router = useRouter()
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const [settled, setSettled] = useState(false)

  // The grant is scoped to the group + account in view when the user approves.
  const groupId = selectedWalletGroup?.groupId

  const decide = (approved: boolean, ttlMs: number | null) => {
    if (settled) return
    setSettled(true)
    const target = groupId === undefined ? undefined : {groupId, accountIndex: selectedAccountIndex}
    void sendConnectDecision(origin ?? '', approved, target, ttlMs).finally(() => {
      if (isExtensionApprovalPopup) closePopup()
      else if (router.canGoBack()) router.back()
    })
  }

  return (
    <DappConnectSheet
      // `cardano` is not a default here: the extension's dApp router speaks CIP-30 only, and its
      // connect message carries no chain to thread through.
      request={origin && groupId !== undefined ? {kind: 'connect', origin, chainType: 'cardano'} : null}
      onApprove={(ttlMs) => decide(true, ttlMs)}
      onReject={() => decide(false, null)}
    />
  )
}
