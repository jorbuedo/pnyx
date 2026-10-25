/**
 * Detect whether the onboarding mnemonic matches an existing wallet group's
 * stored Cardano xpub. On match, stash the groupId + source on the onboarding
 * context (so `preparing.tsx` upgrades that group in place) and surface the
 * existing wallet's name so the name-input screen can pre-fill it.
 *
 * Skipped on quick-start (random mnemonic, can't collide).
 *
 * @module
 */

import {useEffect, useState} from 'react'
import {logger} from '../logger'
import {useConfig, useOnboarding, useWalletData, useWalletList} from '../providers'
import {findExistingWalletForMnemonic} from '../services/duplicate-wallet-detection'
import {useLatestRef} from './useLatestRef'

export function useExistingWalletPrefill(): {matchedName: string | null} {
  const {mnemonic, isQuickStart, setExistingGroupMatch} = useOnboarding()
  const {allWallets} = useWalletList()
  const {getAccountXPub} = useWalletData()
  const {enabledChains} = useConfig()
  const [matchedName, setMatchedName] = useState<string | null>(null)

  // Snapshot wallets at run-time so the once-only detection effect doesn't
  // restart on every wallet-list refresh.
  const allWalletsRef = useLatestRef(allWallets)

  useEffect(() => {
    if (!mnemonic || isQuickStart) return
    let cancelled = false

    ;(async () => {
      try {
        const existing = await findExistingWalletForMnemonic({
          mnemonic,
          wallets: allWalletsRef.current,
          enabledChains,
          getStoredXpub: async (groupId, chainId) => {
            try {
              return await getAccountXPub(chainId, groupId, 0)
            } catch (e: unknown) {
              logger.warn('Stored xpub could not be read; treating it as absent', {
                origin: 'useExistingWalletPrefill',
                chainId,
                groupId,
                error: String(e),
              })
              return null
            }
          },
        })
        if (cancelled) return
        if (existing) {
          setExistingGroupMatch({groupId: existing.groupId, source: existing.source})
          setMatchedName(existing.name)
        }
      } catch (e) {
        logger.debug('Existing-wallet prefill detection failed', {
          origin: 'useExistingWalletPrefill',
          error: e instanceof Error ? e.message : String(e),
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [mnemonic, isQuickStart, enabledChains, getAccountXPub, setExistingGroupMatch])

  return {matchedName}
}
