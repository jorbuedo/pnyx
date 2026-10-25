/**
 * Hook to navigate inline to approval screens on broadcast messages.
 *
 * Listens for NAVIGATE_CONNECT_DAPP and NAVIGATE_CONFIRM_SIGN messages
 * from the background script and navigates to the corresponding route.
 * Only active in extension context.
 *
 * @module
 */

import {type Href, useRouter} from 'expo-router'
import {useEffect} from 'react'

import {addBroadcastListener, isExtension} from '../platform/extension/runtime'

// NAVIGATE_CONFIRM_SIGN is handled by useExtensionSignHost (it needs the wallet rail).
type NavigateMessage = {type: 'NAVIGATE_CONNECT_DAPP'; origin: string}

/**
 * Listen for navigation broadcast messages and push to the appropriate approval route.
 *
 * Must be called in the root layout so it's always active.
 */
export function useApprovalNavigation(): void {
  const router = useRouter()

  useEffect(() => {
    if (!isExtension) return

    const cleanup = addBroadcastListener((raw: unknown) => {
      const message = raw as NavigateMessage
      if (!message || typeof message !== 'object' || !('type' in message)) return

      if (message.type === 'NAVIGATE_CONNECT_DAPP') {
        router.push(`/connect-dapp?origin=${encodeURIComponent(message.origin)}` as Href)
      }
    })

    return cleanup
  }, [router])
}
