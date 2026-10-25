/**
 * Place a resting limit order on SteelSwap's ATC book, through the one canonical
 * review path.
 *
 * ATC differs from the market rail in ways this hook has to enforce before the
 * request rather than after the rejection:
 *
 * - ⚠️ **The owner is the STAKING credential.** `ownerAddress` must carry a
 *   staking part; an enterprise address (`addr1v…`) is rejected outright, and
 *   that same credential must later sign the close. Checked up front so the user
 *   is told why, instead of seeing a bare 400.
 * - **Integer base units**, not the swap family's type-carries-scale convention.
 * - **Keyless** — no credential is minted or sent.
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
import {utxoTokenCount} from '../services/cardano/utxo-view'
import {buildAtcOrder} from '../services/cardano-swap/atc-client'
import {splitBuiltSwapTx} from '../services/cardano-swap/execution'
import {selectSwapUtxos, utxoToCip30Hex, walletUtxoToResolvedInput} from '../services/cardano-swap/signing-context'
import {credentialDepsFor, hardwareBackendFor} from './swap-signing'
import {useCardanoRail} from './useCardanoRail'
import {useToast} from './useToast'

export type LimitOrderInput = {
  /** App asset id of the token being offered. */
  readonly offerAssetId: string
  readonly offerUnit: string
  readonly offerAmount: bigint
  /** Swap-engine unit of the token being asked for. */
  readonly askUnit: string
  readonly askAmount: bigint
}

export type UseLimitOrder = {
  readonly place: (input: LimitOrderInput) => Promise<string | null>
  readonly busy: boolean
  /** `true` when this wallet has no staking credential, so ATC cannot own its orders. */
  readonly unavailable: boolean
}

export const useLimitOrder = (): UseLimitOrder => {
  const {t} = useI18n()
  const {showToast} = useToast()
  const {rail, groupId} = useCardanoRail()
  const {selectedWalletGroup} = useWalletList()
  const hardware = useHardwareWallet()
  const source = selectedWalletGroup?.primaryWallet.source
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const unavailable = rail !== null && rail.account.rewardAddressBech32 === null

  const place = useCallback(
    async (input: LimitOrderInput): Promise<string | null> => {
      if (rail === null || groupId === null) return null
      if (inFlight.current) return null
      const resolved = signerKindOf(source)
      if (resolved === 'script') return null
      const kind = resolved ?? 'software'

      // An enterprise address cannot own an ATC order. Saying so beats letting
      // the API answer 400 with nothing the user can act on.
      if (rail.account.rewardAddressBech32 === null) {
        showToast({variant: 'error', message: t('swap.limit.needsStakeAddress')})
        return null
      }

      inFlight.current = true
      setBusy(true)
      try {
        const spendable = await Effect.runPromise(rail.spendableUtxos)
        const selected = selectSwapUtxos(spendable, {
          inputAssetId: input.offerAssetId,
          inputAmount: input.offerAmount,
        })
        const utxos = selected.map((u) => utxoToCip30Hex(u))
        const collateral = selected.filter((u) => utxoTokenCount(u) === 0).map((u) => utxoToCip30Hex(u))

        const res = await Effect.runPromise(
          Effect.either(
            buildAtcOrder({
              ownerAddress: rail.account.addressBech32,
              offer: {unit: input.offerUnit, amount: input.offerAmount.toString()},
              ask: {unit: input.askUnit, amount: input.askAmount.toString()},
              utxos,
              ...(collateral.length > 0 ? {collateral} : {}),
            }),
          ),
        )
        if (res._tag === 'Left') {
          logger.warn('ATC order build failed', {origin: 'useLimitOrder', error: res.left.reason})
          showToast({variant: 'error', message: t('swap.buildFailed')})
          return null
        }

        const {bodyHex, witnessExtra, foreignVkeyWitnesses, auxHex} = await Effect.runPromise(
          splitBuiltSwapTx(res.right.txCbor),
        )
        const protocolParams = await Effect.runPromise(rail.protocolParams)
        const unconfirmed = await Effect.runPromise(unconfirmedTxHashesOf(rail))
        const resolvedInputs = selected.map((u) => walletUtxoToResolvedInput(u, unconfirmed))
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

        const signingLayer = cardanoSigningLayer(
          rail,
          credentialDepsFor(kind, hardware, t),
          hardwareBackendFor(rail, kind, hardware),
        )
        const {registerReviewTicket} = await import('../screens/cardano/review-handoff')
        return registerReviewTicket({
          legs: [
            {
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
            },
          ],
          groupId,
          audit: {purpose: 'swap', origin: null},
          signingLayer,
          titleKey: 'swap.modeLimit',
          onSettled: () => {},
          onError: () => {},
          onCancel: () => {},
        })
      } catch (e) {
        logger.warn('Limit-order preparation threw', {origin: 'useLimitOrder', error: String(e)})
        showToast({variant: 'error', message: t('swap.buildFailed')})
        return null
      } finally {
        inFlight.current = false
        setBusy(false)
      }
    },
    [rail, groupId, source, hardware, showToast, t],
  )

  return {place, busy, unavailable}
}
