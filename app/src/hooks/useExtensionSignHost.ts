/**
 * Extension sign-host. On the background router's `NAVIGATE_CONFIRM_SIGN`
 * broadcast, fetches the pending request from the router, runs the shared
 * signing core (review ticket for tx, ceremony for data) against the active
 * Cardano rail, and returns the outcome to the router via `DAPP_SIGN_DECISION`.
 * Extension-only; a no-op on native and plain web. See `docs/EXTENSION.md`.
 *
 * @module
 */

import type {CardanoGovKeys} from '@pnyx/wallet'
import {useRouter} from 'expo-router'
import {useEffect, useRef} from 'react'
import type {SignOutcome} from '../../extension/dapp/router'
import {addBroadcastListener, isExtension, isExtensionApprovalPopup} from '../platform/extension/runtime'
import {closePopup} from '../platform/extension/surfaces'
import {useI18n, useWalletAddress, useWalletList} from '../providers'
import {useHardwareWallet} from '../providers/HardwareWalletProvider'
import {getCardanoRail} from '../services/cardano'
import {type CardanoSigningEnv, runSignData, runSignTx} from '../services/dapp/dapp-signing'
import {fetchSignRequest, sendSignDecision} from '../services/dapp/extension-approval'

type NavigateSign = {type?: unknown; requestId?: unknown}

const failure = (message: string): SignOutcome => ({error: {code: -1, message}})

export function useExtensionSignHost(): void {
  const router = useRouter()
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const {getDeriveOnlyAddresses} = useWalletAddress()
  const hardware = useHardwareWallet()
  const {t} = useI18n()
  const govKeysRef = useRef<CardanoGovKeys | null>(null)

  const groupId = selectedWalletGroup?.groupId ?? null
  const source = selectedWalletGroup?.primaryWallet.source

  useEffect(() => {
    if (!isExtension) return

    return addBroadcastListener((raw: unknown) => {
      const m = raw as NavigateSign
      if (!m || typeof m !== 'object' || m.type !== 'NAVIGATE_CONFIRM_SIGN' || typeof m.requestId !== 'string') return
      const requestId = m.requestId

      // Every exit settles the router and, in a transient popup, dismisses it —
      // an approval popup has no history to fall back to.
      const settle = (outcome: SignOutcome) => {
        void sendSignDecision(requestId, outcome).finally(() => {
          if (isExtensionApprovalPopup) closePopup()
        })
      }

      void (async () => {
        try {
          if (groupId === null) return settle(failure('no wallet selected'))
          const details = await fetchSignRequest(requestId)
          if (details === null) return settle(failure('sign request not found'))
          const address = (await getDeriveOnlyAddresses()).cardano
          if (address === undefined) return settle(failure('no Cardano account'))
          const railHandle = getCardanoRail(groupId, address, undefined, {accountIndex: selectedAccountIndex})
          if (railHandle === null) return settle(failure('Cardano rail unavailable'))
          const rail = await railHandle

          const env: CardanoSigningEnv = {hardware, biometricPrompt: t('common.biometricPrompt'), govKeysRef}
          const answer = (response: {result?: unknown; error?: {code: number; message: string}}) =>
            settle(
              response.error
                ? {error: {code: response.error.code, message: response.error.message}}
                : {result: response.result},
            )

          if (details.signType === 'tx') {
            await runSignTx({
              rail,
              groupId,
              source,
              env,
              id: requestId,
              txHex: details.txHex,
              partialSign: details.partialSign,
              origin: details.origin,
              answer,
              navigateToReview: (ticketId) => router.push(`/wallet/review-tx?ticket=${ticketId}` as never),
            })
          } else {
            await runSignData({
              rail,
              groupId,
              source,
              env,
              id: requestId,
              addressHex: details.addressHex,
              payloadHex: details.payloadHex,
              origin: details.origin,
              answer,
              navigateToReview: (ticketId) => router.push(`/wallet/review-tx?ticket=${ticketId}` as never),
            })
          }
        } catch (e) {
          settle(failure(e instanceof Error ? e.message : String(e)))
        }
      })()
    })
  }, [groupId, source, getDeriveOnlyAddresses, hardware, t, router, selectedAccountIndex])
}
