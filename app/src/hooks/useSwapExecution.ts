/**
 * Execute a reviewed swap: build the tx via SteelSwap, split it under our
 * control, and hand it to the SAME review → biometric signing ceremony that
 * Send and dApp flows use. A swap tx carries the DEX's script witnesses /
 * redeemers, so it takes the full-tx path (like a dApp signTx): we keep the body
 * byte-exact, re-attach the script witnesses as `witnessExtra`, and add only our
 * vkey witness at assembly (`signOnly: false`) before submitting.
 *
 * The build is funded from the wallet's own UTxOs (encoded as CIP-30
 * TransactionUnspentOutput hexes) — the same data the dApp connector serves —
 * with pure-ADA UTxOs offered as collateral for Plutus routes.
 *
 * @module
 */

import {Decode} from '@evolution-sdk/review/Decode'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {reviewCardanoTx} from '@pnyx/tx-review'
import {utxoId} from '@pnyx/wallet'
import {Effect} from 'effect'
import {useCallback, useRef, useState} from 'react'
import {logger} from '../logger'
import {useI18n, useWalletList} from '../providers'
import {useHardwareWallet} from '../providers/HardwareWalletProvider'
import {cardanoSigningLayer, pendingTxFrom, registerPendingActivity, unconfirmedTxHashesOf} from '../services/cardano'
import {type KeySignerKind, signerKindOf} from '../services/cardano/signer-kind'
import {buildSwap, notifySwap, quoteChangedEstimate, type SwapEstimate} from '../services/cardano-swap/client'
import {splitBuiltSwapTx} from '../services/cardano-swap/execution'
import {
  isPureAda,
  selectSwapUtxos,
  utxoToCip30Hex,
  walletUtxoToResolvedInput,
} from '../services/cardano-swap/signing-context'
import {assetIdToSwapUnit} from '../services/cardano-swap/swap-asset'
import {credentialDepsFor, hardwareBackendFor} from './swap-signing'
import {useCardanoRail} from './useCardanoRail'
import {useToast} from './useToast'

export type SwapExecutionInput = {
  readonly fromId: string
  readonly toId: string
  /** Base-unit amount of whichever side the user fixed. */
  readonly amountBaseUnits: bigint
  /** Which side `amountBaseUnits` describes. Defaults to the input side. */
  readonly fixed?: 'in' | 'out'
  readonly expectedOutput: {readonly unit: string; readonly amount: string}
  /** REQUIRED when `fixed` is `'out'` — the ceiling the rebuilt input must stay under. */
  readonly expectedInput?: {readonly unit: string; readonly amount: string}
  readonly slippageBps: number
  /** Treat an ADA input as the total leaving the wallet (exactIn + ADA only). */
  readonly allInclusive?: boolean
}

export type UseSwapExecution = {
  /**
   * Build the swap tx and register the shared-ceremony review ticket, returning
   * its id. Runs on the quote screen (where inputs are still editable) so a
   * failed build surfaces before the user commits to the review. `null` on
   * failure (a toast is shown).
   */
  readonly prepare: (input: SwapExecutionInput) => Promise<string | null>
  readonly busy: boolean
}

/**
 * @param onQuoteChanged called with the FRESH quote when the build is rejected
 *   with `409 quote_changed`, so the screen can show the delta and ask again.
 */
export const useSwapExecution = (onQuoteChanged?: (fresh: SwapEstimate) => void): UseSwapExecution => {
  const {t} = useI18n()
  const {showToast} = useToast()
  const {rail, groupId} = useCardanoRail()
  const {selectedWalletGroup} = useWalletList()
  const hardware = useHardwareWallet()
  const source = selectedWalletGroup?.primaryWallet.source
  const [busy, setBusy] = useState(false)
  /**
   * Synchronous re-entrancy guard. `busy` drives the UI but is React state, so it
   * does not gate a second call until the next render — two rapid taps both got
   * through and each spent a metered `swap/build` request.
   */
  const inFlight = useRef(false)

  const prepare = useCallback(
    async (input: SwapExecutionInput): Promise<string | null> => {
      if (rail === null || groupId === null) return null
      if (inFlight.current) return null
      // A read-only wallet is NOT blocked here — it builds + reviews the real tx
      // and is stopped at the signing ceremony (the one place every flow gates
      // signing), so the block is consistent with Send/dApp. 'software' is only
      // the layer's shape; the ceremony fails honestly when there's no vault.
      // A script wallet stops here: its terminal step is signature gathering, and
      // the old `?? 'software'` would have handed it to a key ceremony instead.
      const resolved = signerKindOf(source)
      if (resolved === 'script') return null
      // A read-only wallet is NOT blocked — it builds and reviews the real tx and
      // is stopped at the ceremony, the one place every flow gates signing.
      const kind: KeySignerKind = resolved ?? 'software'
      const inputUnit = assetIdToSwapUnit(input.fromId)
      const outputUnit = assetIdToSwapUnit(input.toId)
      if (inputUnit === null || outputUnit === null) return null

      inFlight.current = true
      setBusy(true)
      try {
        // Read the already-loaded UTxO set (cached Ref — no re-fetch).
        const spendable = await Effect.runPromise(rail.spendableUtxos)
        // Hand the aggregator a MINIMAL covering set — a single pure-ADA UTxO for
        // an ADA swap, plus the token UTxOs for a token sell. Passing the whole
        // set (or big token-dense UTxOs) makes the solver crawl; the aggregator
        // does its own coin selection from what we give it.
        const selected = selectSwapUtxos(spendable, {
          inputAssetId: input.fromId,
          inputAmount: input.amountBaseUnits,
        })
        const utxoHexes = selected.map((u) => utxoToCip30Hex(u))
        const collateral = selected.filter(isPureAda).map((u) => utxoToCip30Hex(u))

        // `Effect.either` rather than a rejected promise: `runPromise` rejects with
        // a FiberFailure wrapper, and the typed reason (which carries the upstream
        // status) is not reliably in its message.
        const buildResult = await Effect.runPromise(
          Effect.either(
            buildSwap(
              {
                side:
                  input.fixed === 'out'
                    ? {kind: 'exactOut', inputUnit, outputUnit, amount: input.amountBaseUnits.toString()}
                    : {kind: 'exactIn', inputUnit, amount: input.amountBaseUnits.toString(), outputUnit},
                expectedOutput: input.expectedOutput,
                // The API requires this on an exactOut build — it is the ceiling
                // the rebuilt input must stay under — and ignores it otherwise.
                ...(input.fixed === 'out' && input.expectedInput !== undefined
                  ? {expectedInput: input.expectedInput}
                  : {}),
                slippageBps: input.slippageBps,
                addressSource: rail.account.addressBech32,
                changeAddress: rail.account.addressBech32,
                ...(utxoHexes.length > 0 ? {utxos: utxoHexes} : {}),
                ...(collateral.length > 0 ? {collateral} : {}),
                ...(input.allInclusive === true ? {allInclusive: true} : {}),
                babelFee: 'ifNeeded',
              },
              Date.now(),
            ),
          ),
        )
        const built = buildResult._tag === 'Right' ? buildResult.right : null
        if (built === null || built.txCbor === '') {
          const failure = buildResult._tag === 'Left' ? buildResult.left : null
          const reason = failure?.reason ?? ''

          // A moved quote is NOT a generic failure: the 409 carries the fresh
          // quote, and the user re-confirms at the new price. Rebuilding
          // silently would fill them at a price they never saw.
          const fresh = failure === null ? null : quoteChangedEstimate(failure)
          if (fresh !== null) {
            onQuoteChanged?.(fresh)
            logger.warn('Swap build rejected — the quote moved', {
              origin: 'useSwapExecution',
              was: input.expectedOutput.amount,
              now: fresh.output.amount,
            })
            return null
          }

          // Branch on the machine code, not the message: "try a different
          // amount or pair" is actively wrong when the aggregator's own chain
          // backend is down, because every pair fails identically.
          const message =
            failure?.code === 'chain_unavailable' || failure?.status === 503
              ? t('swap.buildUnavailableMsg')
              : failure?.code === 'no_route'
                ? t('swap.noRouteMsg')
                : failure?.code === 'insufficient_input'
                  ? t('swap.insufficientInputMsg')
                  : t('swap.buildFailed')
          showToast({variant: 'error', message})
          logger.warn('Swap build failed', {origin: 'useSwapExecution', reason, code: failure?.code ?? null})
          return null
        }

        const {bodyHex, witnessExtra, foreignVkeyWitnesses, auxHex} = await Effect.runPromise(
          splitBuiltSwapTx(built.txCbor),
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

        // Consumed inputs = tx body inputs ∩ our spendable set — so the pending
        // overlay won't reselect them before the swap confirms.
        const {body} = await Effect.runPromise(Inspect.txBody(bodyHex))
        const spendableIds = new Set(spendable.map(utxoId))
        const consumedUtxoIds = body.inputs.map((i) => `${i.txHashHex}:${i.index}`).filter((id) => spendableIds.has(id))

        const signingLayer = cardanoSigningLayer(
          rail,
          credentialDepsFor(kind, hardware, t),
          hardwareBackendFor(rail, kind, hardware),
        )

        const {registerReviewTicket} = await import('../screens/cardano/review-handoff')
        const ticketId = registerReviewTicket({
          legs: [
            {
              reviewed,
              request: {
                groupId,
                payload: {
                  _tag: 'CardanoTx',
                  bodyHex,
                  networkId: rail.config.networkId,
                  protocolMagic: rail.config.protocolMagic,
                  signOnly: false,
                  partial: built.partialSign,
                  ...(witnessExtra.length > 0 ? {witnessExtra} : {}),
                  // A `partialSign` build arrives already co-signed by SteelSwap;
                  // that witness has to survive assembly alongside ours.
                  ...(foreignVkeyWitnesses.length > 0 ? {foreignVkeyWitnesses} : {}),
                  ...(auxHex !== '' ? {auxHex} : {}),
                },
              },
            },
          ],
          groupId,
          audit: {purpose: 'swap', origin: null},
          signingLayer,
          titleKey: 'swap.title',
          onSettled: (results) => {
            const result = results[0]
            if (result?._tag === 'TxSubmitted') {
              const submittedAt = Date.now()
              void Effect.runPromise(
                rail.pendingTracker.register(pendingTxFrom(result.txHash, {consumedUtxoIds, change: []}, submittedAt)),
              )
              registerPendingActivity(rail, result.txHash, reviewed, submittedAt)
              // Tell SteelSwap the moment we broadcast, so the order shows as
              // MEMPOOL during the window before its chain listener indexes it.
              // Best-effort: the swap is already on chain either way, so a
              // failure is logged and the flow continues.
              void Effect.runPromise(Effect.either(notifySwap(result.txHash, result.signedTxHex, submittedAt))).then(
                (r) => {
                  if (r._tag === 'Left') {
                    logger.warn('SteelSwap swap/notify failed; the order stays hidden until it is indexed', {
                      origin: 'useSwapExecution',
                      txHash: result.txHash,
                      error: r.left.reason,
                    })
                  }
                },
              )
              showToast({variant: 'success', message: t('swap.submitted')})
            }
          },
          onError: () => {},
          onCancel: () => {},
        })
        return ticketId
      } catch (e: unknown) {
        logger.warn('Swap transaction could not be built for review', {
          origin: 'useSwapExecution',
          error: String(e),
        })
        showToast({variant: 'error', message: t('swap.buildFailed')})
        return null
      } finally {
        inFlight.current = false
        setBusy(false)
      }
    },
    [rail, groupId, source, hardware, showToast, t, onQuoteChanged],
  )

  return {prepare, busy}
}
