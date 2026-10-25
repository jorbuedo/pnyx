/**
 * Cancel a resting swap order, on either rail, through the one canonical review
 * path.
 *
 * The two rails cancel differently and both shapes have to be honoured:
 *
 * - **AMM** — `POST /swap/cancel` returns **one transaction per Plutus-version
 *   bucket** (zero, one or two: a single tx cannot mix V1 hash-datum and V2/V3
 *   inline-datum witness styles). Every returned tx is a separate leg of the
 *   same ceremony. Orders that could not be cancelled ride back in `skipped`
 *   rather than failing the call, so an all-skipped batch is a `200` with no
 *   transactions — surfaced here as a reason, never as silence.
 * - **Limit (ATC)** — one CLOSE per order, which both collects a filled order's
 *   proceeds and cancels a resting one. ⚠️ It must be signed by the **staking**
 *   credential the order was placed with, not the payment key.
 *
 * @module
 */

import {Decode} from '@evolution-sdk/review/Decode'
import {reviewCardanoTx} from '@pnyx/tx-review'
import {Effect} from 'effect'
import {useCallback, useRef, useState} from 'react'
import {logger} from '../logger'
import {useI18n, useWalletList} from '../providers'
import {useHardwareWallet} from '../providers/HardwareWalletProvider'
import {cardanoSigningLayer, unconfirmedTxHashesOf} from '../services/cardano'
import {signerKindOf} from '../services/cardano/signer-kind'
import {buildAtcClose} from '../services/cardano-swap/atc-client'
import {cancelSwap} from '../services/cardano-swap/client'
import {splitBuiltSwapTx} from '../services/cardano-swap/execution'
import type {NormalizedOrder} from '../services/cardano-swap/order-model'
import {isPureAda, utxoToCip30Hex, walletUtxoToResolvedInput} from '../services/cardano-swap/signing-context'
import {credentialDepsFor, hardwareBackendFor} from './swap-signing'
import {useCardanoRail} from './useCardanoRail'
import {useToast} from './useToast'

export type CancelOutcome = {
  /** Review-ticket id to navigate to, or `null` when nothing was cancellable. */
  readonly ticketId: string | null
  /** Machine reasons for orders that produced no cancel. */
  readonly skipped: readonly {readonly id: string; readonly reason: string}[]
  /** Orders cancelled whose original fee could not be refunded. */
  readonly refundSkipped: readonly {readonly id: string; readonly reason: string}[]
}

export type UseOrderCancel = {
  readonly cancel: (order: NormalizedOrder) => Promise<CancelOutcome | null>
  /**
   * The id of the order currently being cancelled, or `null`.
   *
   * Deliberately not a boolean: one shared flag spun EVERY row's button at once,
   * which said the app was cancelling all of them.
   */
  readonly busyId: string | null
}

export const useOrderCancel = (): UseOrderCancel => {
  const {t} = useI18n()
  const {showToast} = useToast()
  const {rail, groupId} = useCardanoRail()
  const {selectedWalletGroup} = useWalletList()
  const hardware = useHardwareWallet()
  const source = selectedWalletGroup?.primaryWallet.source
  const [busyId, setBusyId] = useState<string | null>(null)
  const inFlight = useRef(false)

  const cancel = useCallback(
    async (order: NormalizedOrder): Promise<CancelOutcome | null> => {
      if (rail === null || groupId === null) return null
      if (inFlight.current) return null
      const resolved = signerKindOf(source)
      // A script wallet's terminal step is signature gathering, not a key ceremony.
      if (resolved === 'script') return null
      const kind = resolved ?? 'software'

      inFlight.current = true
      setBusyId(order.id)
      try {
        // A cancel spends a script UTxO, so it always needs collateral; the
        // reclaimed order value covers the rest, so no coin selection is needed
        // beyond offering pure-ADA UTxOs.
        const spendable = await Effect.runPromise(rail.spendableUtxos)
        const selected = [...spendable].filter(isPureAda).slice(0, 5)
        const utxoHexes = selected.map((u) => utxoToCip30Hex(u))
        const collateral = utxoHexes

        const cbors: string[] = []
        let skipped: readonly {readonly id: string; readonly reason: string}[] = []
        let refundSkipped: readonly {readonly id: string; readonly reason: string}[] = []

        if (order.rail === 'amm') {
          const [txHash, indexStr] = order.id.split('#')
          const res = await Effect.runPromise(
            Effect.either(
              cancelSwap(
                [{txHash: txHash ?? order.txHash, txIndex: indexStr === undefined ? 0 : Number(indexStr)}],
                rail.account.addressBech32,
                collateral.length > 0 ? collateral : undefined,
                Date.now(),
              ),
            ),
          )
          if (res._tag === 'Left') {
            logger.warn('Cancel build failed', {origin: 'useOrderCancel', id: order.id, error: res.left.reason})
            showToast({variant: 'error', message: t('swapOrders.loadFailed')})
            return null
          }
          cbors.push(...res.right.transactions.map((tx) => tx.txCbor))
          skipped = res.right.skipped.map((s) => ({id: `${s.txHash}#${s.txIndex}`, reason: s.reason}))
          refundSkipped = res.right.refundSkipped.map((s) => ({id: `${s.txHash}#${s.txIndex}`, reason: s.reason}))
        } else {
          // ATC: the close is signed by the STAKING credential, and some wallets
          // only attach that signature when the reward account appears in the tx.
          const owner = rail.account.rewardAddressBech32
          if (owner === null) {
            showToast({variant: 'error', message: t('swapOrders.limitOwnerUnavailable')})
            return null
          }
          const res = await Effect.runPromise(
            Effect.either(
              buildAtcClose(order.id, {
                ownerAddress: rail.account.addressBech32,
                utxos: utxoHexes,
                ...(collateral.length > 0 ? {collateral} : {}),
                addWithdrawal: true,
              }),
            ),
          )
          if (res._tag === 'Left') {
            logger.warn('ATC close build failed', {origin: 'useOrderCancel', id: order.id, error: res.left.reason})
            showToast({variant: 'error', message: t('swapOrders.loadFailed')})
            return null
          }
          cbors.push(res.right)
        }

        // An all-skipped batch is a 200 with no transactions. Reporting it as a
        // reason is the whole point — silence here reads as "nothing happened".
        if (cbors.length === 0) return {ticketId: null, skipped, refundSkipped}

        const protocolParams = await Effect.runPromise(rail.protocolParams)
        const unconfirmed = await Effect.runPromise(unconfirmedTxHashesOf(rail))
        const resolvedInputs = selected.map((u) => walletUtxoToResolvedInput(u, unconfirmed))

        const legs = []
        for (const cbor of cbors) {
          const {bodyHex, witnessExtra, foreignVkeyWitnesses, auxHex} = await Effect.runPromise(splitBuiltSwapTx(cbor))
          const reviewed = await Effect.runPromise(
            reviewCardanoTx(
              bodyHex,
              rail.account.walletContext,
              resolvedInputs,
              protocolParams,
              undefined,
              undefined,
              auxHex,
            ).pipe(Effect.provideService(Decode, rail.decode)),
          )
          legs.push({
            reviewed,
            request: {
              groupId,
              payload: {
                _tag: 'CardanoTx' as const,
                bodyHex,
                networkId: rail.config.networkId,
                protocolMagic: rail.config.protocolMagic,
                signOnly: false,
                ...(witnessExtra.length > 0 ? {witnessExtra} : {}),
                ...(foreignVkeyWitnesses.length > 0 ? {foreignVkeyWitnesses} : {}),
                ...(auxHex !== '' ? {auxHex} : {}),
              },
            },
          })
        }

        const signingLayer = cardanoSigningLayer(
          rail,
          credentialDepsFor(kind, hardware, t),
          hardwareBackendFor(rail, kind, hardware),
        )
        const {registerReviewTicket} = await import('../screens/cardano/review-handoff')
        const ticketId = registerReviewTicket({
          legs,
          groupId,
          audit: {purpose: 'swap', origin: null},
          signingLayer,
          titleKey: 'swapOrders.cancelCta',
          onSettled: () => {},
          onError: () => {},
          onCancel: () => {},
        })
        return {ticketId, skipped, refundSkipped}
      } catch (e) {
        logger.warn('Cancel preparation threw', {origin: 'useOrderCancel', id: order.id, error: String(e)})
        showToast({variant: 'error', message: t('swapOrders.loadFailed')})
        return null
      } finally {
        inFlight.current = false
        setBusyId(null)
      }
    },
    [rail, groupId, source, hardware, showToast, t],
  )

  return {cancel, busyId}
}
