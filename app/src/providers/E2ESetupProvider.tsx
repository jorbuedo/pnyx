/**
 * E2E Setup Provider.
 *
 * Wraps the app and ensures E2E flags are set before any routing occurs.
 * This must be the outermost provider to ensure flags are set before
 * index.tsx checks storage for routing decisions.
 *
 * @module
 */

import {type ReactNode, useEffect, useState} from 'react'
import {ActivityIndicator, View} from 'react-native'
import {DEFAULT_NETWORK} from '../config/networks'
import {isE2EAutoRestoreEnabled} from '../hooks/useE2EAutoRestore'
import {logger} from '../logger'
import {storage} from '../platform/storage'

type E2ESetupProviderProps = {
  children: ReactNode
}

/**
 * Provider that sets up E2E flags before rendering children.
 *
 * In E2E mode, blocks rendering until all init flags are set.
 * In normal mode, renders children immediately.
 */
export function E2ESetupProvider({children}: E2ESetupProviderProps) {
  const [isReady, setIsReady] = useState(!isE2EAutoRestoreEnabled())

  useEffect(() => {
    if (!isE2EAutoRestoreEnabled()) return

    const setup = async () => {
      logger.info('E2E: Setting up flags to skip init screens', {origin: 'E2ESetupProvider'})

      try {
        await Promise.all([
          storage.set('@pnyx/legal_agreement', JSON.stringify({acceptedAt: Date.now()})),
          storage.set('@pnyx/init_new_or_return_done', 'return'),
          // The build's own default, not a hardcoded network. This wrote `'mainnet'` regardless of
          // `EXPO_PUBLIC_CARDANO_NETWORK`, so a preseeded run silently ignored the one knob that
          // selects a chain — and since the wallet's Midnight addresses are derived per network at
          // restore, an E2E run could not be pointed at preprod at all.
          storage.set('@pnyx/network', DEFAULT_NETWORK),
        ])

        logger.info('E2E: Flags set successfully', {origin: 'E2ESetupProvider'})
      } catch (error) {
        logger.error('E2E: Failed to set flags', {
          origin: 'E2ESetupProvider',
          error: error instanceof Error ? error.message : String(error),
        })
      }

      setIsReady(true)
    }

    setup()
  }, [])

  if (!isReady) {
    return (
      <View style={{flex: 1, justifyContent: 'center', alignItems: 'center'}}>
        <ActivityIndicator size="large" />
      </View>
    )
  }

  return <>{children}</>
}
