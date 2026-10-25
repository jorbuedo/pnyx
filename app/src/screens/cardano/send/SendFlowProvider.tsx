/**
 * Draft state for the multi-step send funnel, scoped to the `/wallet/send`
 * route group: recipients (`SendState.targets`), the hub-level asset basket,
 * balance/rail plumbing, address resolution, and the review handoff that
 * builds the unsigned tx and pushes `/wallet/review-tx`. Mounted by the
 * group's `_layout`, so the draft dies with the funnel.
 *
 * @module
 */

import {AddressHex} from '@evolution-sdk/review/Brands'
import {Decode} from '@evolution-sdk/review/Decode'
import {CARDANO_MAINNET} from '@pnyx/config'
import {reviewCardanoTx} from '@pnyx/tx-review'
import {Cause, Effect, Exit, Option} from 'effect'
import {useLocalSearchParams, useRouter} from 'expo-router'
import {createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react'
import {useCardanoRail} from '../../../hooks/useCardanoRail'
import {useCardanoSigningLayer} from '../../../hooks/useCardanoSigningLayer'
import {useNetworkCapabilities} from '../../../hooks/useNetworkCapabilities'
import {useProgrammableHoldings} from '../../../hooks/useProgrammableHoldings'
import {useToast} from '../../../hooks/useToast'
import {logger} from '../../../logger'
import {useConfig, useFormat, useI18n, useWalletData, useWalletList} from '../../../providers'
import {
  buildSendReviewFittingSize,
  type CardanoRail,
  pendingTxFrom,
  registerPendingActivity,
  resolveRecipient,
} from '../../../services/cardano'
import {selectCip113Deployment} from '../../../services/cardano/cip113/deployment-selection'
import {programmableIntents} from '../../../services/cardano/cip113/intents'
import {resolveProgrammableRecipient} from '../../../services/cardano/cip113/recipient'
import {buildProgrammableTransfer} from '../../../services/cardano/cip113/send-transfer'
import {
  buildConsolidation,
  type ConsolidationLeg,
  loadWalletOptimization,
} from '../../../services/cardano/consolidation'
import {buildCoFundedSend, coFundMessage} from '../../../services/cardano/multiparty/co-funded-send'
import {gatherContributableUtxos} from '../../../services/cardano/multiparty/gather'
import {resolveCardanoParams} from '../../../services/cardano/params'
import {cardanoRailLayer} from '../../../services/cardano/rail'
import {changeUtxosFromPlan} from '../../../services/cardano/send-flow'
import {isChainable, legFromSendReview, reviewQueuedLegs, type SendQueueLeg} from '../../../services/cardano/send-queue'
import {parseMidnightAssetId} from '../../../services/midnight/wallet/midnight-asset-id'
import {routeRecipient} from '../../../services/send/recipient-rail'
import {buildGatherContext, withGather} from '../multisig-gather'
import {type ReviewTicket, registerReviewTicket} from '../review-handoff'
import {minAdaForOutput} from './min-ada'
import {claimSendPrefill} from './send-prefill-handoff'
import {
  ADA_ID,
  applyBasketToSingleTarget,
  CARDANO_RAIL,
  emptyBasket,
  emptyTarget,
  initialSendState,
  type ResolvedTarget,
  type SendBasket,
  type SendState,
  setSendRail,
  setSoleTargetAmount,
  setTargetAddress,
  setTargetAmount,
  setTargetMidnightResolution,
  setTargetResolution,
  validateMidnightSend,
  validateSend,
  withPrefill,
} from './state'
import {useSendQueue} from './use-send-queue'

/** ADA cushion reserved for the fee on an ADA send-all; the build tightens it. */
export const ADA_FEE_RESERVE = 1_000_000n
const ADA_DECIMALS = 6

/** The `kind` a build failure carries, or `null` when the cause is not one of ours. */
const buildFailureKindOf = (cause: Cause.Cause<unknown>): string | null => {
  const failure = Option.getOrUndefined(Cause.failureOption(cause))
  return failure !== undefined && typeof failure === 'object' && failure !== null && 'kind' in failure
    ? String((failure as {kind: unknown}).kind)
    : null
}

export type SendFlow = {
  readonly state: SendState
  readonly setState: (update: (s: SendState) => SendState) => void
  readonly basket: SendBasket
  readonly setBasket: (update: (b: SendBasket) => SendBasket) => void
  /** Own asset balances (assetId → quantity); ADA under {@link ADA_ID}. */
  readonly balance: ReadonlyMap<string, bigint>
  /** Held native-token ids (for the asset picker). */
  readonly heldAssetIds: readonly string[]
  /**
   * Of those, the ones held in a CIP-113 smart wallet.
   *
   * Offered by the picker and refused on selection, never hidden: a token the user can see in
   * their portfolio and cannot find in the picker is a dead end with no explanation.
   */
  readonly programmableAssetIds: ReadonlySet<string>
  /**
   * What an asset picker should list: everything held, ordinary and programmable alike.
   *
   * Derived rather than folded into `heldAssetIds`, which the balance effect owns — programmable
   * holdings resolve on their own schedule, and a list built inside that effect would simply miss
   * them. That is exactly what made the first attempt at this inert.
   */
  readonly pickerAssetIds: readonly string[]
  /**
   * What a *contributing* wallet holds — ADA under {@link ADA_ID}, tokens by asset id.
   *
   * `balance` above is the selected wallet's, which is the composer's, and the composer is
   * one contributor among several. Reusing it for anyone else states one wallet's holdings
   * under another's name: the picker offers tokens they may not have, and "50%" is half of
   * somebody else's money. A watched wallet's balance is not in local state — only its
   * addresses are — so this reads it the way the build does.
   */
  readonly balanceOfSource: (groupId: string) => Promise<ReadonlyMap<string, bigint>>
  /** Recipient index currently resolving, or null. */
  readonly resolvingIndex: number | null
  /** True once the rail address is loaded — resolution attempts before this no-op. */
  readonly railReady: boolean
  /** Resolve a recipient's raw input (bech32 / $handle) into address bytes. */
  readonly resolveAddress: (index: number, raw: string) => void
  /** Fill a recipient from a picked contact and resolve it. */
  readonly selectContact: (index: number, address: string) => void
  /**
   * Build the unsigned tx and push the review funnel.
   *
   * `amount` writes a figure onto the sole recipient *before* validating, for a rail whose amount
   * step commits and reviews in one press. It is threaded rather than left to `setState` because a
   * React state update does not land before the next line: `startReview()` would validate the state
   * as it was and report an empty amount for one the user had just typed.
   */
  readonly startReview: (options?: {
    readonly amount?: {readonly assetId: string; readonly quantity: bigint}
  }) => Promise<void>
  readonly reviewBusy: boolean
  /**
   * Freeze the current send onto the compose queue and reset the funnel, so the
   * next send can spend its change. The queued legs are all reviewed together
   * when the user finally continues instead of queueing again.
   */
  readonly queueCurrent: () => Promise<void>
  readonly queuedLegs: readonly SendQueueLeg[]
  readonly canQueueMore: boolean
  readonly discardQueuedLeg: (legId: string) => Promise<void>
}

const SendFlowContext = createContext<SendFlow | null>(null)

export const useSendFlow = (): SendFlow => {
  const ctx = useContext(SendFlowContext)
  if (ctx === null) throw new Error('useSendFlow must be used inside SendFlowProvider')
  return ctx
}

export const SendFlowProvider = ({children}: {children: ReactNode}) => {
  const {t} = useI18n()
  const format = useFormat()
  const {network} = useConfig()
  const {adaTicker} = useNetworkCapabilities()
  const router = useRouter()
  const {showToast} = useToast()
  const {selectedWalletGroup} = useWalletList()
  const {listAddressesForWallet} = useWalletData()
  const {signerKind, source, resolveSigningLayer} = useCardanoSigningLayer()
  // The canonical rail — same one portfolio, activity, stake and swap use. Send
  // used to build its own from the primary address alone, which made it blind to
  // every other address the account owns: it reported 3.06872 ADA available on a
  // wallet holding 1,327.0643, and could only ever have spent primary UTxOs.
  const {rail, shared, loading: railLoading} = useCardanoRail()
  const programmable = useProgrammableHoldings()
  /**
   * Balance as the amount steps see it: the rail's, plus programmable holdings.
   *
   * Derived rather than merged into the balance effect, which owns `balance` and runs on its own
   * schedule — programmable holdings resolve separately, so a merge inside it would miss them.
   * Without this every percentage pill computes against a quantity of zero, because `balance` has
   * no entry for a token the rail cannot see.
   */
  const programmableAmounts = useMemo(
    () =>
      new Map<string, bigint>(
        programmable.kind === 'ready'
          ? programmable.rows.flatMap((r) =>
              r.tokens.map((t) => [`${t.policyIdHex}.${t.assetNameHex}`, t.amount] as const),
            )
          : [],
      ),
    [programmable],
  )
  const programmableIds = useMemo(
    () =>
      new Set(
        programmable.kind === 'ready'
          ? programmable.rows.flatMap((r) => r.tokens.map((t) => `${t.policyIdHex}.${t.assetNameHex}`))
          : [],
      ),
    [programmable],
  )

  const [state, setStateRaw] = useState<SendState>(initialSendState)
  const [basket, setBasketRaw] = useState<SendBasket>(emptyBasket)
  const [balance, setBalance] = useState<ReadonlyMap<string, bigint>>(new Map())
  const [heldAssetIds, setHeldAssetIds] = useState<readonly string[]>([])
  const [resolvingIndex, setResolvingIndex] = useState<number | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)

  const groupId = selectedWalletGroup?.groupId ?? null
  const sendQueue = useSendQueue(rail, groupId)
  /** Id of a payment request that opened this flow; see the claim effect below. */
  const {prefill: prefillParam} = useLocalSearchParams<{prefill?: string}>()

  useEffect(() => {
    let active = true
    if (rail === null) return
    void (async () => {
      try {
        await Effect.runPromise(rail.sync)
        // Compose-aware: queued legs have committed these funds already, so the
        // amount steps must not offer them again.
        const bal = await Effect.runPromise(
          sendQueue.overlayEntries.length === 0 ? rail.balance : rail.composeBalance(sendQueue.overlayEntries),
        )
        if (!active) return
        const map = new Map<string, bigint>([[ADA_ID, bal.primary.quantity]])
        for (const s of bal.secondary) map.set(s.id, s.quantity)
        setBalance(map)
        setHeldAssetIds(bal.secondary.map((s) => s.id))
      } catch (e: unknown) {
        // Best-effort — the authoritative build and validation run on review — but the funnel
        // then shows the previous balance, which reads as a wallet that has not changed.
        logger.warn('Send funnel balance preview failed; the previous figures stand', {
          origin: 'SendFlowProvider',
          error: String(e),
        })
      }
    })()
    return () => {
      active = false
    }
    // `rail` is replaced as discovery widens the known-address set, and each
    // replacement is a better balance — so re-read on identity, not just on group.
  }, [rail, sendQueue.overlayEntries])

  /**
   * The ledger's per-output min-ADA, which needs the rail's codec and the epoch's
   * `coinsPerUtxoByte`. Returns a calculator yielding `null` when either is
   * unavailable — an unknown floor must not block a send, and the build remains
   * authoritative, which is exactly what happened before this check existed.
   */
  const resolveMinAdaFor = useCallback(async (): Promise<(target: ResolvedTarget) => bigint | null> => {
    if (rail === null) return () => null
    try {
      const params = await Effect.runPromise(Effect.either(resolveCardanoParams(rail)))
      if (params._tag !== 'Right') return () => null
      const perByte = params.right.coinsPerUtxoByte
      return (target) => minAdaForOutput(perByte, AddressHex(target.addressHex), target.amounts)
    } catch (e: unknown) {
      // ⚠️ `() => null` is "no min-ADA known", which disables the floor check for the whole
      // funnel — the output is then only rejected when the node sees it.
      logger.warn('Protocol params unavailable; the send funnel cannot check the min-ADA floor', {
        origin: 'SendFlowProvider',
        error: String(e),
      })
      return () => null
    }
  }, [rail])

  const withRail = useCallback(
    async (fn: (rail: CardanoRail) => Promise<void>) => {
      if (rail === null) {
        // ⚠️ **Still loading is not "not configured".** The build message is a statement about the
        // app's configuration, and showing it while the rail is merely being built told the user
        // their Cardano network was missing two seconds after launch — on a build where it was
        // there. Logged either way, because silence here means a dead Review button with nothing in
        // the log; the caller that meets this while loading is retried by `RecipientsScreen` once
        // `railReady`.
        if (railLoading) {
          logger.info('send rail not ready yet', {origin: 'SendFlowProvider', hasGroup: groupId !== null})
          return
        }
        logger.warn('send rail unavailable', {origin: 'SendFlowProvider', hasGroup: groupId !== null})
        showToast({variant: 'error', message: t('cardanoSend.errors.railUnavailable')})
        return
      }
      await fn(rail)
    },
    [rail, railLoading, groupId, showToast, t],
  )

  const resolveAddress = useCallback(
    (index: number, raw: string) => {
      // Which chain this send is for is the recipient's to decide, and deciding it needs no network
      // call — so it happens before the Cardano rail is consulted at all. A Midnight address used to
      // be refused here with a message telling the user to go and find another screen; it now moves
      // the funnel onto that rail instead (`services/send/recipient-rail.ts`).
      const trimmed = raw.trim()
      const route = routeRecipient(trimmed, network)
      if (route.rail === 'midnight') {
        // Only the first slot decides. Switching rail collapses the funnel to one recipient, so
        // honouring a Midnight address in slot 2 would silently drop slot 1 — money to an address
        // the user did not pick, which is the direction of mistake that must not be possible.
        if (index > 0) {
          logger.warn('midnight recipient in a later slot', {origin: 'SendFlowProvider', index})
          showToast({variant: 'error', message: t('cardanoSend.errors.midnightOneRecipient')})
          return
        }
        if (!route.onOurNetwork) {
          logger.warn('midnight recipient on another network', {
            origin: 'SendFlowProvider',
            addressNetwork: route.network,
          })
          showToast({variant: 'error', message: t('cardanoSend.errors.wrongNetworkAddress')})
          return
        }
        setStateRaw((st) =>
          setTargetMidnightResolution(setSendRail(st, {chain: 'midnight', rail: route.kind}), index, trimmed),
        )
        return
      }
      if (route.rail === 'unusable') {
        logger.warn('recipient is an unusable Midnight address', {
          origin: 'SendFlowProvider',
          reason: route.reason,
        })
        showToast({
          variant: 'error',
          message: t(
            route.reason === 'dust-address'
              ? 'cardanoSend.errors.midnightDustAddress'
              : 'cardanoSend.errors.midnightDamaged',
          ),
        })
        return
      }
      // A Cardano address on a funnel that had switched to Midnight switches it back — the rail
      // follows the address, in both directions.
      setStateRaw((st) => setSendRail(st, CARDANO_RAIL))
      setResolvingIndex(index)
      void withRail(async (rail) => {
        const result = await Effect.runPromise(Effect.either(resolveRecipient(raw, rail)))
        if (result._tag === 'Right') {
          setStateRaw((s) => setTargetResolution(s, index, result.right.addressHex, result.right.name))
        } else {
          setStateRaw((s) => setTargetResolution(s, index, null, null))
          const kind = result.left.kind
          logger.warn('recipient resolution failed', {
            origin: 'SendFlowProvider',
            kind,
            reason: result.left.reason,
          })
          const key =
            kind === 'handle-not-found'
              ? 'handleNotFound'
              : kind === 'handle-unavailable'
                ? 'handleUnavailable'
                : // A wrong-network address is well-formed, so "enter a valid address"
                  // sends the user hunting for a typo that isn't there.
                  kind === 'wrong-network'
                  ? 'wrongNetworkAddress'
                  : // Midnight kinds cannot reach here: `routeRecipient` above classifies the input
                    // first, from the same network, and never forwards one of those to this resolver.
                    kind === 'cns-not-found' || kind === 'cns-expired'
                    ? 'handleNotFound'
                    : kind === 'cns-unavailable'
                      ? 'handleUnavailable'
                      : kind === 'lookup-failed'
                        ? 'resolutionUnavailable'
                        : 'unresolvedAddress'
          showToast({variant: 'error', message: t(`cardanoSend.errors.${key}` as never)})
        }
      }).finally(() => setResolvingIndex(null))
    },
    [withRail, showToast, t, network],
  )

  const selectContact = useCallback(
    (index: number, contactAddress: string) => {
      setStateRaw((s) => setTargetAddress(s, index, contactAddress))
      resolveAddress(index, contactAddress)
    },
    [resolveAddress],
  )

  /**
   * A payment request that opened this flow — a scanned QR, a deep link, a card
   * tapped in a message.
   *
   * Claimed once and evicted, so a re-mount cannot re-apply a request the user has
   * since edited. The address then goes through the ordinary resolution, which is
   * what validates it: a link does not get to assert that its own address is good,
   * and a wrong-network one has to fail here rather than at build time.
   */
  const prefillClaimed = useRef(false)
  useEffect(() => {
    if (prefillClaimed.current || typeof prefillParam !== 'string' || prefillParam === '') return
    prefillClaimed.current = true
    const prefill = claimSendPrefill(prefillParam)
    if (prefill === undefined) return
    logger.info('send prefilled from a payment request', {
      origin: 'SendFlowProvider',
      requestOrigin: prefill.origin,
      hasAmount: prefill.lovelace !== null,
    })
    const {lovelace} = prefill
    setStateRaw((s) => withPrefill(s, {address: prefill.addressBech32, lovelace}))
    if (lovelace !== null) setBasketRaw((b) => ({...b, amounts: new Map([...b.amounts, [ADA_ID, lovelace]])}))
    // ⚠️ **Seeded, not resolved here.** This effect runs on mount, and the Cardano rail is still
    // being built then — resolving now found `rail === null` and told the user the Cardano network
    // was not configured for this build, on a build where it plainly was. `RecipientsScreen`
    // resolves every unresolved target once `railReady`, which is the same path a typed address
    // takes and the reason the send worked anyway.
  }, [prefillParam])

  /**
   * The CIP-113 path: resolve the recipient to their smart wallet, assemble the transfer, and hand
   * it to the same review ceremony every other signature goes through.
   */
  const runProgrammableBuild = useCallback(
    async (assetIds: readonly string[]) => {
      if (groupId === null || rail === null) return
      // Every recipient, not the first one. This read `state.targets[0]` and mapped the whole
      // basket to it, so a two-recipient send built a valid transaction that paid one of them and
      // returned the rest as change — no error, nothing in the review to notice, and it would have
      // submitted. The same single-vs-many basket rule the ordinary path uses (see `buildReview`).
      const effective = state.targets.length === 1 ? applyBasketToSingleTarget(state, basket) : state
      const targets = effective.targets.filter((tg) => tg.address.trim().length > 0)
      if (targets.length === 0) {
        showToast({variant: 'error', message: t('cardanoSend.errors.noRecipients')})
        return
      }
      setReviewBusy(true)
      try {
        const selection = selectCip113Deployment({protocolMagic: rail.config.protocolMagic})
        if (selection.kind !== 'active') {
          showToast({variant: 'error', message: t('cardanoSend.errors.railUnavailable')})
          return
        }
        const build = programmableIntents(targets, assetIds, (address) =>
          resolveProgrammableRecipient(address, selection.deployment, rail.config.networkId),
        )
        if (build.kind === 'refused') {
          // The recipient cannot hold one. Said here rather than discovered at submit — and named,
          // because with several recipients "that address" does not say whose.
          const who = targets.length > 1 ? `${build.address.slice(0, 12)}…: ` : ''
          showToast({variant: 'error', message: `${who}${build.detail}`})
          return
        }
        if (build.kind === 'empty') {
          showToast({variant: 'error', message: t('cardanoSend.errors.noRecipients')})
          return
        }
        const {intents} = build
        const built = await Effect.runPromise(
          buildProgrammableTransfer(rail, groupId, intents).pipe(Effect.provide(cardanoRailLayer(rail.config))),
        )
        if (built.kind === 'refused') {
          logger.warn('programmable transfer refused', {
            origin: 'SendFlowProvider',
            reason: built.reason,
            detail: built.detail,
          })
          showToast({variant: 'error', message: built.detail})
          return
        }
        // ⚠️ A transaction leg, not a message leg. This moves tokens, and the first cut registered
        // it as a message — so a transfer rendered under "Sign message" while its payload signed as
        // a transaction. The screen must name what is actually being authorised.
        const params = await Effect.runPromise(rail.protocolParams)
        const reviewed = await Effect.runPromise(
          reviewCardanoTx(
            built.bodyHex,
            // The deployment's programmable-logic script is a *shared* payment credential: ours
            // only over our own stake key. Without naming it the review reads a smart-wallet input
            // as somebody else's, and the transfer renders as pure gain.
            {
              ...rail.account.walletContext,
              sharedPaymentScriptHashes: new Set([selection.deployment.plbScriptHashHex.toLowerCase()]),
            },
            built.resolvedInputs,
            params,
          ).pipe(Effect.provideService(Decode, rail.decode)),
        )
        const programmableChange = await Effect.runPromise(changeUtxosFromPlan(rail, built.changeOutputs))
        const signingLayer = await resolveSigningLayer(rail, groupId)
        const {registerReviewTicket} = await import('../review-handoff')
        const ticketId = registerReviewTicket({
          legs: [{reviewed, request: built.request}],
          groupId,
          audit: {purpose: 'send', origin: null},
          titleKey: 'cardanoSend.programmableTitle',
          signingLayer,
          // The send is done; land on the wallet home where the pending row shows. Without it
          // `TxReviewScreen` falls back to `router.back()`, which walks the user back into the
          // completed send they just made — the ordinary path has carried this all along.
          doneHref: '/wallets',
          onSettled: (results) => {
            const submittedAt = Date.now()
            for (const result of results) {
              if (result._tag !== 'TxSubmitted') continue
              // The funding UTxOs this spent are ordinary ones the next send would otherwise be
              // offered again, because the indexer will not know they are gone for a while. The
              // smart-wallet inputs come along harmlessly: they are not in the spendable set the
              // overlay filters, so naming them costs nothing and skipping them needs a rule.
              void Effect.runPromise(
                rail.pendingTracker.register(
                  pendingTxFrom(
                    result.txHash,
                    {
                      consumedUtxoIds: built.resolvedInputs.map((i) => `${i.txHashHex}:${i.index}`),
                      // ⚠️ The ORDINARY change — our own coins coming back, not the smart-wallet
                      // outputs holding the token remainder. Left empty, the overlay removed the
                      // funding inputs and put nothing back, so the wallet under-reported its own
                      // balance until the transfer confirmed: 12 ada displayed against a real 27,327.
                      change: programmableChange,
                    },
                    submittedAt,
                  ),
                ),
              )
              // Show it in Activity now — the indexer will not return it for a while, and until
              // then the user has no evidence their transfer happened.
              registerPendingActivity(rail, result.txHash, reviewed, submittedAt)
            }
          },
          onError: (error) => {
            logger.warn('programmable transfer signing failed', {origin: 'SendFlowProvider', error: String(error)})
          },
          onCancel: () => {},
        })
        router.push(`/wallet/review-tx?ticket=${ticketId}` as never)
      } finally {
        setReviewBusy(false)
      }
    },
    [groupId, rail, state, basket, showToast, t, resolveSigningLayer, router],
  )

  const runBuild = useCallback(
    async (mode: 'review' | 'queue', amount?: {readonly assetId: string; readonly quantity: bigint}) => {
      // Applied here rather than awaited from `setState`: the caller's figure has to be in the
      // state this function validates, and a state update does not land mid-callback. It is also
      // written back, so the screen behind the review shows what was reviewed.
      // ⚠️ Midnight replaces rather than merges: its rail pays one token, and a user who picked one,
      // went back and picked another would otherwise arrive at the review with both — which
      // `validateMidnightSend` refuses as `invalidAmount`, naming neither of them.
      const write = state.rail.chain === 'midnight' ? setSoleTargetAmount : setTargetAmount
      const current = amount === undefined ? state : write(state, 0, amount.assetId, amount.quantity)
      if (amount !== undefined) setStateRaw(current)
      // Midnight leaves the funnel here. None of what follows applies: there is no min-ada floor, no
      // ADA fee reserve, no size fitting, no consolidation and no queue — a transfer is one output
      // and the fee is DUST somebody else pays. The review screen builds and submits from these
      // three facts, so this step only has to establish that they are complete.
      //
      // The funds check is not repeated here on purpose: the amount step owns it, because that is
      // where the Midnight balance is read and where an "insufficient" can be shown against the
      // field that caused it. Validating with a balance this provider does not have would mean
      // inventing one.
      if (current.rail.chain === 'midnight') {
        if (mode === 'queue') {
          logger.warn('queue is not available on the Midnight rail', {origin: 'SendFlowProvider'})
          return
        }
        const midnight = validateMidnightSend(current, null)
        if (!midnight.ok) {
          logger.warn('midnight send validation blocked review', {
            origin: 'SendFlowProvider',
            error: midnight.error,
          })
          showToast({variant: 'error', message: t(`cardanoSend.errors.${midnight.error}` as never)})
          return
        }
        // The token travels too. It is read back off the validated asset id rather than assumed to be
        // NIGHT: the shielded rail has no NIGHT at all, so a review told to spend it is asked for a
        // colour that cannot exist.
        const asset = parseMidnightAssetId(midnight.assetId)
        if (asset === null) {
          logger.warn('midnight review blocked: the chosen amount carries no readable token', {
            origin: 'SendFlowProvider',
            assetId: midnight.assetId,
          })
          showToast({variant: 'error', message: t('cardanoSend.errors.noAssets')})
          return
        }
        router.push({
          pathname: '/wallet/midnight/review',
          params: {
            to: midnight.address,
            rail: current.rail.rail,
            amount: midnight.amount.toString(),
            tokenType: asset.tokenType,
          },
        })
        return
      }
      if (groupId === null) {
        showToast({variant: 'error', message: t('cardanoSend.errors.noWalletSelected')})
        return
      }
      // A CIP-113 token cannot ride the ordinary builder: its inputs are script UTxOs and moving
      // them runs the protocol. Branching here rather than at the picker keeps one funnel — the
      // basket is only a quantity map, and it is the *build* that must differ.
      const programmablePicked = [...basket.amounts.keys()].filter((id) => programmableIds.has(id))
      if (programmablePicked.length > 0) {
        await runProgrammableBuild(programmablePicked)
        return
      }
      // Single recipient: the basket IS that recipient's amounts. Multi: the
      // allocate step already wrote per-target amounts.
      const effective = state.targets.length === 1 ? applyBasketToSingleTarget(state, basket) : state
      const minAdaFor = await resolveMinAdaFor()
      const validation = validateSend(effective, balance, {adaFeeReserve: ADA_FEE_RESERVE, minAdaFor})
      if (!validation.ok) {
        logger.warn('send validation blocked review', {
          origin: 'SendFlowProvider',
          error: validation.error,
          ...(validation.error === 'belowMinAda' ? {requiredMinAda: String(validation.requiredMinAda)} : {}),
        })
        const required = validation.error === 'belowMinAda' ? validation.requiredMinAda : undefined
        showToast({
          variant: 'error',
          message:
            required === undefined
              ? t(`cardanoSend.errors.${validation.error}` as never)
              : t('cardanoSend.errors.belowMinAdaAmount', {
                  amount: format(required, {preset: 'cryptoTxDetail', currency: adaTicker, decimals: ADA_DECIMALS}),
                }),
        })
        return
      }
      // A watch-only wallet is not blocked here: it builds and reviews like any
      // other wallet, and only signing is unavailable (the review screen says so).
      // Any *other* sourceless wallet is a real configuration problem.
      if (signerKind === null && source !== 'read-only') {
        logger.warn('send blocked: no signer for wallet source', {origin: 'SendFlowProvider', source: String(source)})
        showToast({variant: 'error', message: t('cardanoSend.errors.railUnavailable')})
        return
      }
      const sendAllIdx = effective.targets.findIndex((tg) => tg.sendAll.has(ADA_ID))
      const adaSendAll = sendAllIdx >= 0 ? {targetIndex: sendAllIdx, reserve: ADA_FEE_RESERVE} : undefined
      setReviewBusy(true)
      await withRail(async (rail) => {
        // Co-funded: a different build and a different destination. None of what follows
        // applies — size-fitting and auto-consolidation fold *this* wallet's UTxO set, and
        // the review screen signs and submits, which a transaction still owed other
        // people's signatures must not do. It goes to the co-sign screen instead, where
        // every signature is collected including this wallet's own.
        if (effective.sources.length > 0) {
          const built = await buildCoFundedSend({
            rail,
            groupId,
            name: selectedWalletGroup?.name ?? null,
            sources: effective.sources.map((src) => ({
              groupId: src.groupId,
              name: src.name,
              isComposer: src.isComposer,
              lovelace: src.lovelace,
              assets: src.assets,
            })),
            targets: validation.targets,
            addressesOf: async (id) =>
              (
                await listAddressesForWallet(id, CARDANO_MAINNET).catch((e) => {
                  logger.warn('Address list read failed; that wallet contributes no addresses', {
                    origin: 'SendFlowProvider',
                    groupId: id,
                    error: String(e),
                  })
                  return []
                })
              ).map((row) => row.human),
            now: new Date().toISOString(),
          })
          if (!built.ok) {
            // `coFundMessage`, not the compose branch alone. Routing only `compose` here
            // sent every *other* refusal — an unbalanced total, a contributed token, a
            // wallet that could not be read, the builder's own sentence — to one flat
            // "could not build", which is the failure this union was shaped to end.
            showToast({variant: 'error', message: coFundMessage(built, t, format, adaTicker)})
            return
          }
          router.push(`/wallet/cosign?pendingId=${encodeURIComponent(built.pendingId)}` as never)
          return
        }
        const sendParams = {
          targets: validation.targets,
          memo: validation.memo,
          ...(adaSendAll !== undefined ? {adaSendAll} : {}),
        }
        // `runPromiseExit` so the typed build error survives — a rejected promise
        // only exposes a FiberFailure wrapper (its `.kind` is undefined), which
        // collapsed every failure (funds included) into the generic "build failed".
        let exit = await Effect.runPromiseExit(
          buildSendReviewFittingSize(rail, groupId, {
            ...sendParams,
            // Chain onto anything already queued: its inputs are spoken for and
            // its change is available.
            composeOver: sendQueue.overlayEntries,
          }),
        )

        // Both protocol bounds are remedied by folding the UTxO set first, and a
        // token-heavy wallet hits the *value* bound before the size one — measured
        // on mainnet, where 1,200 ADA over 128 UTxOs fails with a 27,746-byte
        // change value against a 5,000-byte limit, never reaching `too-large` at
        // all. Splitting recipients cannot help either bound when the cause is the
        // input side. Only with the user's standing permission: it costs a fee.
        let consolidationLegs: readonly ConsolidationLeg[] = []
        const failedOnAProtocolBound =
          Exit.isFailure(exit) && ['too-large', 'value-too-large'].includes(buildFailureKindOf(exit.cause) ?? '')
        if (failedOnAProtocolBound) {
          const policy = await loadWalletOptimization()
          if (policy.autoConsolidate) {
            const folded = await Effect.runPromiseExit(buildConsolidation(rail, groupId, policy))
            if (Exit.isSuccess(folded)) {
              // A leg's tracking info *is* the overlay entry: inputs it spends are
              // gone, outputs it emits are spendable.
              const overlay = [...sendQueue.overlayEntries, ...folded.value.legs.map((leg) => leg.review.tracked)]
              const retried = await Effect.runPromiseExit(
                buildSendReviewFittingSize(rail, groupId, {...sendParams, composeOver: overlay}),
              )
              // Only keep the fold if it actually made the send fit. Charging for a
              // consolidation and then still failing is the worst of both.
              if (Exit.isSuccess(retried)) {
                consolidationLegs = folded.value.legs
                exit = retried
                showToast({
                  variant: 'info',
                  message: t('cardanoSend.queue.autoConsolidated', {count: consolidationLegs.length}),
                })
              } else {
                // Discarded, and the user sees the ORIGINAL bound error — so this
                // is the only trace that a fold was attempted. Reached for real:
                // folding packs asset groups up to `maxValueSize`, so a send that
                // must pull one of those outputs in still overflows its change.
                // The remedy is splitting change across several outputs, not
                // folding harder.
                logger.warn('auto-consolidation did not make the send fit; discarding it', {
                  origin: 'SendFlowProvider',
                  foldLegs: folded.value.legs.length,
                  reason: Cause.pretty(retried.cause),
                })
              }
            } else {
              logger.warn('auto-consolidation before send failed', {
                origin: 'SendFlowProvider',
                reason: Cause.pretty(folded.cause),
              })
            }
          }
        }

        if (Exit.isFailure(exit)) {
          const failure = Option.getOrUndefined(Cause.failureOption(exit.cause))
          const buildKind = buildFailureKindOf(exit.cause)
          const reason =
            failure !== undefined && 'reason' in failure
              ? String((failure as {reason: unknown}).reason)
              : Cause.pretty(exit.cause)
          logger.warn('send tx build failed', {origin: 'SendFlowProvider', kind: buildKind, reason})
          // `unsafe-params` is not the user's fault and its reason is internal —
          // never interpolate it into the message.
          const key =
            buildKind === 'insufficient-funds' || buildKind === 'empty-wallet'
              ? 'insufficientFunds'
              : buildKind === 'unsafe-params'
                ? 'unsafeParams'
                : buildKind === 'too-large'
                  ? 'tooLarge'
                  : // A different bound with a different remedy: the assets must
                    // move to another output, not another transaction.
                    buildKind === 'value-too-large'
                    ? 'valueTooLarge'
                    : 'buildFailed'
          showToast({variant: 'error', message: t(`cardanoSend.errors.${key}` as never, {reason})})
          return
        }
        const {review, targetsDropped} = exit.value

        // The send did not fit in one transaction. Queue what did and restart the
        // funnel on the remainder, which then chains onto this leg's change. Doing
        // it here rather than in the builder keeps the atomicity change visible:
        // two transactions pay two fees and the second is only valid if the first
        // lands.
        if (targetsDropped.length > 0) {
          // Both remedies in one pass is not supported: the compose queue would
          // have to absorb the fold *and* the partial send, and two appends in one
          // tick lose the first (the hook's `queue` closes over the legs it saw).
          // Unreachable in practice — recipients are capped and a freshly folded
          // wallet has few inputs — so say so rather than build for it.
          if (consolidationLegs.length > 0) {
            showToast({variant: 'error', message: t('cardanoSend.errors.consolidateFirst')})
            return
          }
          if (!isChainable(legFromSendReview(review, review.txHash, 0))) {
            // No change output means nothing for the next leg to spend.
            showToast({variant: 'error', message: t('cardanoSend.errors.tooLarge')})
            return
          }
          if (await sendQueue.queue(review)) {
            setStateRaw({
              targets: targetsDropped.map((t) => ({...emptyTarget(), addressHex: t.addressHex})),
              memo: '',
              // Queueing is a Cardano-only path: a Midnight send leaves `runBuild` before it.
              rail: CARDANO_RAIL,
              // The queued leg took the sources with it; the remainder is an ordinary
              // send until the user adds them again.
              sources: [],
            })
            setBasketRaw(emptyBasket())
            showToast({
              variant: 'info',
              message: t('cardanoSend.queue.autoSplit', {count: targetsDropped.length}),
            })
            router.dismissTo('/wallet/send' as never)
          }
          return
        }

        // Queue mode stops here: nothing is signed, so no vault touch and no
        // signing layer. Reset the funnel so the next send starts clean, with this
        // leg's inputs already spoken for.
        if (mode === 'queue') {
          if (await sendQueue.queue(review)) {
            setStateRaw(initialSendState())
            setBasketRaw(emptyBasket())
            router.dismissTo('/wallet/send' as never)
          }
          return
        }

        const signingLayer: ReviewTicket['signingLayer'] = await resolveSigningLayer(rail, groupId)

        // Queued legs are re-reviewed from their persisted bodies, then this build
        // is appended as the final leg — submission order.
        const queuedReviews = await Effect.runPromise(
          reviewQueuedLegs(rail, sendQueue.legs).pipe(Effect.orElseSucceed(() => null)),
        )
        if (queuedReviews === null && sendQueue.legs.length > 0) {
          showToast({variant: 'error', message: t('cardanoSend.queue.restoreFailed')})
          return
        }
        // Submission order, each leg carrying its own tracking info. Built as one
        // list rather than reconstructed by index inside `onSettled`: that used to
        // pick `tracked` from a position-based guess, which silently mis-attributes
        // the moment a third kind of leg joins — as auto-consolidation just did.
        const ceremony: readonly {
          readonly reviewed: (typeof review)['reviewed']
          readonly request: (typeof review)['request']
          readonly tracked: (typeof review)['tracked']
        }[] = [
          ...(queuedReviews ?? []).map((reviewed, i) => ({
            reviewed,
            request: sendQueue.legs[i]?.request as (typeof sendQueue.legs)[number]['request'],
            // A queued leg's change is re-derived on resume, not persisted as a
            // value, so it contributes only its spent inputs here.
            tracked: {consumedUtxoIds: sendQueue.legs[i]?.consumedUtxoIds ?? [], change: []},
          })),
          ...consolidationLegs.map((leg) => ({
            reviewed: leg.review.reviewed,
            request: leg.review.request,
            tracked: leg.review.tracked,
          })),
          {reviewed: review.reviewed, request: review.request, tracked: review.tracked},
        ]

        // A shared wallet's signature is one of several, so the ceremony has to
        // be a single transaction: an envelope carries one body, and a queued
        // leg spending an earlier leg's change cannot be gathered independently.
        // The queue affordance is withheld for these wallets (`canQueueMore`),
        // so reaching here means auto-consolidation added a leg.
        if (shared !== null && ceremony.length > 1) {
          logger.warn('shared wallet send would need several transactions', {
            origin: 'SendFlowProvider',
            legs: ceremony.length,
          })
          showToast({variant: 'error', message: t('cardanoSend.errors.sharedSingleTx')})
          return
        }
        const gather = await Effect.runPromise(
          buildGatherContext({
            rail,
            shared,
            bodyHex: review.bodyHex,
            createdAt: new Date().toISOString(),
          }).pipe(
            Effect.provideService(Decode, rail.decode),
            Effect.orElseSucceed(() => null),
          ),
        )

        const ticketId = registerReviewTicket(
          withGather(
            {
              legs: ceremony.map(({reviewed, request}) => ({reviewed, request})),
              groupId,
              audit: {purpose: 'send', origin: null},
              signingLayer,
              ...(signingLayer === null ? {cannotSignReasonKey: 'txReview.cannotSign.watchOnly'} : {}),
              // The send is done; land on the wallet home where the pending row shows.
              doneHref: '/wallets',
              onSettled: (results) => {
                const submittedAt = Date.now()
                results.forEach((result, index) => {
                  if (result._tag !== 'TxSubmitted') return
                  const leg = ceremony[index]
                  if (leg === undefined) return
                  void Effect.runPromise(
                    rail.pendingTracker.register(pendingTxFrom(result.txHash, leg.tracked, submittedAt)),
                  )
                  // Show it in Activity now — the indexer will not return it for a
                  // while, and until then the user has no evidence their send happened.
                  registerPendingActivity(rail, result.txHash, leg.reviewed, submittedAt)
                })
                // Every landed leg leaves the queue immediately, whether or not the
                // whole ceremony finished. A broadcast transaction that stayed
                // queued would keep claiming funds it has already spent. Only the
                // queued legs are in the queue, and they come first.
                void sendQueue.dropLanded(Math.min(results.length, sendQueue.legs.length))
              },
              onError: () => {},
              onCancel: () => {},
            },
            gather,
            // Route type isn't inferred for the new group yet; narrow cast per CLAUDE.md.
            (pendingId) => router.push(`/wallet/cosign?pendingId=${pendingId}` as never),
          ),
        )
        // Route type isn't inferred for the new group yet; narrow cast per CLAUDE.md.
        router.push(`/wallet/review-tx?ticket=${ticketId}` as never)
      }).finally(() => setReviewBusy(false))
    },
    [
      groupId,
      state,
      basket,
      balance,
      source,
      signerKind,
      resolveSigningLayer,
      withRail,
      router,
      showToast,
      t,
      resolveMinAdaFor,
      format,
      adaTicker,
      sendQueue,
      shared,
      listAddressesForWallet,
      selectedWalletGroup?.name,
      programmableIds,
      runProgrammableBuild,
    ],
  )

  const startReview = useCallback(
    (options?: {readonly amount?: {readonly assetId: string; readonly quantity: bigint}}) =>
      runBuild('review', options?.amount),
    [runBuild],
  )
  const queueCurrent = useCallback(() => runBuild('queue'), [runBuild])

  /**
   * A contributing wallet's balance, read the same way the build reads its coins.
   *
   * The composer answers from local state — it is the selected wallet and its balance is
   * already loaded. Anyone else is a watched wallet whose holdings live on chain and
   * nowhere on this device, so it costs the one `accountUtxos` call
   * `gatherContributableUtxos` makes. Called when a screen needs the figure rather than
   * when a wallet is added, so co-funding plain ADA from a wallet whose amount you type
   * outright costs nothing.
   *
   * An empty map is "we could not read it", which the callers render as *unknown* rather
   * than as zero — a co-funder shown "Available: 0" would be told they cannot contribute.
   */
  const balanceOfSource = useCallback(
    async (sourceGroupId: string): Promise<ReadonlyMap<string, bigint>> => {
      if (sourceGroupId === groupId) return balance
      if (rail === null) return new Map()
      const addresses = (
        await listAddressesForWallet(sourceGroupId, CARDANO_MAINNET).catch((e) => {
          logger.warn('Address list read failed; the source balance reads as empty', {
            origin: 'SendFlowProvider',
            groupId: sourceGroupId,
            error: String(e),
          })
          return []
        })
      ).map((row) => row.human)
      if (addresses.length === 0) return new Map()
      const gathered = await Effect.runPromise(Effect.either(gatherContributableUtxos({rail, addresses})))
      if (gathered._tag === 'Left') {
        logger.warn('co-fund: could not read a contributing wallet balance', {
          origin: 'balanceOfSource',
          groupId: sourceGroupId,
          reason: gathered.left.reason,
        })
        return new Map()
      }
      const totals = new Map<string, bigint>([[ADA_ID, 0n]])
      for (const utxo of gathered.right) {
        totals.set(ADA_ID, (totals.get(ADA_ID) ?? 0n) + utxo.lovelace)
        for (const [id, quantity] of utxo.assets ?? []) totals.set(id, (totals.get(id) ?? 0n) + quantity)
      }
      return totals
    },
    [groupId, balance, rail, listAddressesForWallet],
  )

  const value = useMemo<SendFlow>(
    () => ({
      state,
      setState: setStateRaw,
      basket,
      setBasket: setBasketRaw,
      // Programmable holdings are folded in here, not in the balance effect — see the note on
      // `programmableAmounts`. The amount steps read this, and a percentage of a quantity the map
      // does not carry is zero.
      balance: programmableAmounts.size === 0 ? balance : new Map([...balance, ...programmableAmounts]),
      heldAssetIds,
      programmableAssetIds: programmableIds,
      pickerAssetIds: [...heldAssetIds, ...[...programmableIds].filter((id) => !heldAssetIds.includes(id))],
      balanceOfSource,
      resolvingIndex,
      railReady: rail !== null,
      resolveAddress,
      selectContact,
      startReview,
      reviewBusy,
      queueCurrent,
      queuedLegs: sendQueue.legs,
      // A queued send is several transactions chained through their change, and
      // a shared wallet's transaction is not finished when it is signed — each
      // leg would need its own gathering round before the next could be built.
      // Withheld rather than offered and then refused.
      canQueueMore: sendQueue.canQueueMore && shared === null,
      discardQueuedLeg: sendQueue.discard,
    }),
    [
      state,
      basket,
      balance,
      heldAssetIds,
      programmableIds,
      balanceOfSource,
      resolvingIndex,
      rail,
      resolveAddress,
      selectContact,
      startReview,
      reviewBusy,
      queueCurrent,
      sendQueue.legs,
      sendQueue.canQueueMore,
      sendQueue.discard,
      shared,
      programmableAmounts,
    ],
  )

  return <SendFlowContext.Provider value={value}>{children}</SendFlowContext.Provider>
}
