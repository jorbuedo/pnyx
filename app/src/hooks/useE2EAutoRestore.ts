/**
 * E2E Auto-Restore Hook.
 *
 * Automatically restores a wallet from mnemonic on e2e-preseed builds,
 * allowing Maestro tests to skip onboarding and start directly
 * with Send/Swap/etc flows.
 *
 * Triggered when: EXPO_PUBLIC_E2E_AUTO_RESTORE=true (set in .env.e2e-preseed)
 *
 * Environment variables:
 *   EXPO_PUBLIC_E2E_AUTO_RESTORE - Set to 'true' in .env.e2e-preseed
 *   EXPO_PUBLIC_E2E_MNEMONIC - 24-word mnemonic (EAS secrets, e2e-preseed env)
 *   EXPO_PUBLIC_E2E_WALLET_NAME - Wallet name (EAS secrets)
 *
 * The restored seed lands in the enclave vault. On an emulator this
 * requires a configured screen lock (see docs/mobile-shell-plan.md).
 *
 * @module
 */

import type {ChainId} from '@pnyx/config'
import {useEffect, useRef, useState} from 'react'
import {e2eAutoRestore, e2eMnemonic, e2eWalletName} from '../config/env'
import {logger} from '../logger'
import {useWalletCore, useWalletList} from '../providers'
import {FUNDS_CHAINS} from '../services/chains'

const E2E_AUTO_RESTORE = e2eAutoRestore()
const E2E_MNEMONIC = e2eMnemonic()
const E2E_WALLET_NAME = e2eWalletName()

/**
 * Check if we're running in E2E preseed mode.
 * Auto-restore is enabled when EXPO_PUBLIC_E2E_AUTO_RESTORE=true (set in .env.e2e-preseed).
 */
export function isE2EAutoRestoreEnabled(): boolean {
  return E2E_AUTO_RESTORE === 'true'
}

/**
 * Hook that auto-restores a wallet on E2E builds.
 *
 * Call this in the root layout or a provider that wraps the app.
 * It will:
 * 1. Check if E2E mode is enabled and mnemonic is provided
 * 2. Check if wallet already exists (skip if so)
 * 3. Restore wallet from mnemonic
 *
 * @returns isComplete - true when restore is done (or skipped)
 */
export function useE2EAutoRestore(): {isComplete: boolean} {
  const {isReady} = useWalletCore()
  const {wallets, restoreWallet, enableChainForGroup} = useWalletList()
  const [isComplete, setIsComplete] = useState(false)
  const hasAttemptedRestore = useRef(false)

  useEffect(() => {
    // Only run in E2E mode with mnemonic provided
    if (!isE2EAutoRestoreEnabled()) {
      setIsComplete(true)
      return
    }

    // Wait for wallet service to be ready
    if (!isReady) return

    // Skip if wallet already exists
    if (wallets.length > 0) {
      logger.info('E2E: Wallet already exists, skipping auto-restore', {origin: 'E2EAutoRestore'})
      setIsComplete(true)
      return
    }

    // Prevent double restore
    if (hasAttemptedRestore.current) return
    hasAttemptedRestore.current = true

    const performRestore = async () => {
      try {
        // Validate required environment variables
        const missingVars: string[] = []
        if (!E2E_MNEMONIC) missingVars.push('EXPO_PUBLIC_E2E_MNEMONIC')
        if (!E2E_WALLET_NAME) missingVars.push('EXPO_PUBLIC_E2E_WALLET_NAME')

        if (missingVars.length > 0) {
          logger.error('E2E: Missing required environment variables for e2e-preseed build', {
            origin: 'E2EAutoRestore',
            missingVars,
            hint: 'Set these in EAS secrets under the e2e-preseed environment',
          })
          setIsComplete(true)
          return
        }

        const walletName = E2E_WALLET_NAME as string
        const mnemonic = E2E_MNEMONIC as string

        logger.info('E2E: Auto-restoring wallet', {origin: 'E2EAutoRestore', walletName})

        // Note: Init flags are already set by E2ESetupProvider which runs before this hook.
        // This hook only handles wallet restoration.

        // Restore the primary wallet
        const primaryWallet = await restoreWallet({
          name: walletName,
          mnemonic,
        })

        // Enable additional default chains for the wallet group
        // This creates wallets for each chain using the same mnemonic
        const defaultChains = FUNDS_CHAINS
        const additionalChains = defaultChains.filter((chainId) => chainId !== primaryWallet.chainId)

        for (const chainId of additionalChains) {
          try {
            await enableChainForGroup(primaryWallet.groupId, chainId as ChainId)
          } catch (chainError) {
            logger.warn('E2E: Failed to enable chain', {
              origin: 'E2EAutoRestore',
              chainId,
              error: chainError instanceof Error ? chainError.message : String(chainError),
            })
          }
        }

        logger.info('E2E: Wallet restored', {origin: 'E2EAutoRestore', chains: defaultChains.length})
      } catch (error) {
        logger.error('E2E: Failed to auto-restore wallet', {
          origin: 'E2EAutoRestore',
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        // Mark complete regardless of success/failure so app doesn't hang
        setIsComplete(true)
      }
    }

    performRestore()
  }, [isReady, wallets.length, restoreWallet, enableChainForGroup])

  return {isComplete}
}
