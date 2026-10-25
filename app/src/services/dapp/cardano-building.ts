/**
 * Running a Cardano build for an agent: resolve the intent, build it, and — only if asked — carry it
 * through the wallet's own review to the chain.
 *
 * ⚠️ **`submit` is not a shortcut past consent.** With it the transaction goes to the *same* review
 * screen every other producer uses ([[one-canonical-review-path]]); what it removes is the step an
 * agent cannot perform, not the step the person performs. Without it the agent gets an unsigned
 * transaction and nothing has happened.
 *
 * ⚠️ **The agent's job ends when the review opens, and that is why it is answered there.** An earlier
 * version held the agent's call open through the decision and the broadcast, and it lost the answer to
 * a race it could not win: approving navigates to `/wallets`, which unmounts the agents screen, which
 * stops serving and closes the relay socket — so the reply for a transaction that had *already landed*
 * was written to a socket that was gone. The agent was told "the wallet is not connected" for a
 * transfer that was on chain (verified: preprod block 5,105,159), and an agent acting on that would ask
 * the person to approve the same payment twice. Nothing about the navigation is wrong; holding an
 * answer past the point where the caller can still be reached is.
 *
 * So a submit path answers with the hand-off: what was built, its fee, and the hash it goes out under
 * if the person approves — which is knowable because `AgentBuild.txHash` is fixed once the body is
 * built and signing only adds a witness set. The decision and its outcome belong to the person and the
 * chain; an agent that wants to know reads `cardano_readTransaction` or `cardano_listHistory`, or asks
 * them.
 *
 * ⚠️ **And it is not optional in practice, which is worth stating plainly.** A CIP-30 `signTx` answers
 * with a *witness set*; assembling that into a transaction and broadcasting it is what a dApp's own
 * library does, and an agent holding JSON has no way to do it. So an agent that builds without
 * `submit: true` can inspect a transaction and hand it to a person — it cannot land it.
 *
 * ⚠️ **Submitting through this path is also what keeps the wallet's UTxO view honest.** The review's
 * request broadcasts and registers the pending overlay, so a second build sees the first one's change
 * and does not re-select inputs it has already spent. `cardano_submitTx` — the CIP-30 method — is a raw
 * broadcast that registers nothing, correctly, because a dApp's transaction is not ours to track.
 *
 * @module
 */

import {AddressHex, Bech32} from '@evolution-sdk/review/Brands'
import {Decode} from '@evolution-sdk/review/Decode'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {Address} from '@pnyx/cardano-core'
import type {LocalToolOutcome} from '@pnyx/mcp-server'
import {type ResolvedInput, type ReviewedTransaction, reviewCardanoTx} from '@pnyx/tx-review'
import {Effect} from 'effect'
import type {TranslationKey} from '../../i18n/types'
import {logger} from '../../logger'
import {registerReviewTicket} from '../../screens/cardano/review-handoff'
import {minAdaForOutput} from '../../screens/cardano/send/min-ada'
import type {ResolvedTarget} from '../../screens/cardano/send/state'
import {networkFitFor} from '../cardano/address-network'
import {
  type AgentBuild,
  type AgentMint,
  agentBuildFrom,
  buildAgentDelegation,
  buildAgentDeploy,
  buildAgentMint,
  buildAgentTransferChain,
  mintingPolicyFor,
  withMinAda,
} from '../cardano/agent-build'
import {chainTip} from '../cardano/chain-tip'
import {cip25AuxiliaryData} from '../cardano/cip25'
import {misroutedAssets, misroutedMessage, requestedAssetIds} from '../cardano/cip113/agent-asset-split'
import {selectCip113Deployment} from '../cardano/cip113/deployment-selection'
import {programmableIntents} from '../cardano/cip113/intents'
import {resolveProgrammableRecipient} from '../cardano/cip113/recipient'
import {buildProgrammableTransfer} from '../cardano/cip113/send-transfer'
import {readOwnProgrammableHoldings} from '../cardano/cip113/smart-wallet'
import {
  buildConsolidation,
  type ConsolidationOutcome,
  loadWalletOptimization,
  type WalletOptimization,
} from '../cardano/consolidation'
import {
  addSignature,
  envelopeWitnessesFrom,
  partialSignRequest,
  platformCosignRegistry,
  requiredFor,
  stableCosignId,
  statusOf,
  submitEnvelope,
  type TxEnvelope,
} from '../cardano/cosign'
import {resolveInputsWithChain, spentInputCountOf} from '../cardano/cosign/foreign-inputs'
import {consumedUtxoIdsOf} from '../cardano/cosign/track-submitted'
import {pendingTxFrom, registerPendingActivity} from '../cardano/index'
import {buildCoFundedSend, type CoFundResult, type CoFundSource} from '../cardano/multiparty/co-funded-send'
import type {ComposeFailure} from '../cardano/multiparty/compose'
import {type CardanoRail, cardanoRailLayer} from '../cardano/rail'
import {changeUtxosFromPlan, type SendBuildError} from '../cardano/send-flow'
import {signerKindOf, signsAlone} from '../cardano/signer-kind'
import {createCardanoTxContext, resolvedInputsFromSpendable} from '../cardano/signing-adapters'
import {type DRepTarget, parseDRepTarget} from '../cardano-pool-drep/drep-id'
import type {
  ParsedCoFund,
  ParsedConsolidation,
  ParsedCoSign,
  ParsedDelegation,
  ParsedDeploy,
  ParsedMint,
  ParsedOutput,
  ParsedProgrammableTransfer,
  ParsedTransfer,
} from '../mcp/build-args'
import {describeTransaction} from '../mcp/describe-tx'
import {recordOutcome} from '../mcp/outcomes'
import {handedAnswer} from './agent-answer'
import {type CardanoSigningEnv, signingLayerFor} from './dapp-signing'

const ORIGIN = 'agent-cardano-build'

/** Everything the runner needs that is not in the call itself. */
export type AgentBuildEnv = {
  readonly rail: CardanoRail
  readonly groupId: string
  /** The wallet's source, which decides whether it can sign alone at all. */
  readonly source: string | undefined
  readonly env: CardanoSigningEnv
  /** The agent origin, recorded verbatim in the signing audit. */
  readonly origin: string
  readonly navigateToReview: (ticketId: string) => void
}

const refuse = (message: string): LocalToolOutcome => ({ok: false, message})

/**
 * Turn one parsed recipient into a plan target.
 *
 * ⚠️ **The network is checked here and refused, never switched.** A mainnet address handed to a preprod
 * wallet builds a perfectly valid transaction that can only ever be rejected — and the app's own
 * "switch network?" answer is a question for a person, not something to decide on an agent's behalf.
 */
export const resolveTargets = (
  rail: CardanoRail,
  outputs: readonly ParsedOutput[],
): Effect.Effect<readonly ResolvedTarget[], Error> =>
  Effect.forEach(outputs, (output, i) =>
    Effect.gen(function* () {
      const fit = networkFitFor(output.address, rail.config.network)
      if (fit.kind === 'unknown') {
        return yield* Effect.fail(new Error(`outputs[${i}].address is not a Cardano address: ${output.address}`))
      }
      if (fit.kind === 'switch') {
        return yield* Effect.fail(
          new Error(
            `outputs[${i}].address is a ${fit.switchTo === 'mainnet' ? 'mainnet' : 'testnet'} address and this ` +
              `wallet is on ${fit.from}. The person has to switch networks in Pnyx; the wallet will not do it for them.`,
          ),
        )
      }
      const addressHex = yield* Address.fromBech32(Bech32(output.address)).pipe(
        Effect.mapError(() => new Error(`outputs[${i}].address could not be decoded: ${output.address}`)),
      )
      return {addressHex, amounts: output.amounts}
    }),
  )

/**
 * Settle every output's lovelace against the min-ADA floor.
 *
 * ⚠️ **Raised when the caller said nothing, refused when they said too little.** An output carrying
 * assets must hold a minimum of ADA or the ledger rejects the whole transaction — but quietly raising
 * an amount the caller *stated* would send more ADA than they asked for, and they would find out from
 * the chain. Naming the floor lets them decide.
 */
const applyMinAda = (
  rail: CardanoRail,
  parsed: readonly ParsedOutput[],
  targets: readonly ResolvedTarget[],
): Effect.Effect<readonly ResolvedTarget[], Error> =>
  Effect.gen(function* () {
    const params = yield* rail.protocolParams.pipe(
      Effect.mapError((e) => new Error(`the protocol parameters could not be read: ${e.message}`)),
    )
    return yield* Effect.forEach(targets, (target, i) => {
      const floor = minAdaForOutput(params.coinsPerUtxoByte, AddressHex(target.addressHex), target.amounts)
      const coin = target.amounts.get('') ?? 0n
      // ⚠️ Unknown, never zero. Waving an output through on an unmeasurable floor is the
      // `OutputTooSmallUTxO` this whole check exists to prevent, arriving silently.
      if (floor === null) {
        return Effect.fail(new Error(`outputs[${i}]: the minimum lovelace for that output could not be measured`))
      }
      if (coin >= floor) return Effect.succeed(target)
      if (parsed[i]?.lovelaceGiven === true) {
        return Effect.fail(
          new Error(
            `outputs[${i}].lovelace is ${coin} but an output carrying those assets needs at least ${floor} ` +
              'lovelace to exist on chain. Raise it, or leave `lovelace` out and the wallet will use exactly that.',
          ),
        )
      }
      return Effect.succeed(withMinAda(params.coinsPerUtxoByte, target))
    })
  })

/**
 * What the agent is handed for a build it must carry itself.
 *
 * ⚠️ **A list, and the order is load-bearing** when there is more than one: each leg spends the
 * previous one's change, so submitting them out of order — or one of them alone — spends inputs the
 * next leg was built against.
 */
const unsignedAnswer = (builds: readonly AgentBuild[], extra: Record<string, unknown> = {}): LocalToolOutcome => ({
  ok: true,
  value: {
    submitted: false,
    ...extra,
    ...(builds.length === 1
      ? {
          txHex: builds[0]?.unsignedTxHex,
          txHash: builds[0]?.txHash,
          fee: builds[0]?.reviewed.fee.toString(),
          inputs: builds[0]?.tracked.consumedUtxoIds.length,
          outputs: builds[0]?.reviewed.outputs.length,
        }
      : {
          chained: true,
          transactions: builds.map((b) => ({
            txHex: b.unsignedTxHex,
            txHash: b.txHash,
            fee: b.reviewed.fee.toString(),
            outputs: b.reviewed.outputs.length,
          })),
        }),
  },
})

/**
 * Why a build failed, in a sentence the model can act on.
 *
 * ⚠️ A size overflow is answered with the number of recipients that **would** fit. Anything else leaves
 * an agent guessing at a batch size, and guessing costs a full build per attempt.
 */
const buildFailureMessage = (error: unknown): string => {
  // `SendBuildError` already carries the classification the send flow made; re-deriving it from the
  // thrown cause would be a second opinion about the same failure.
  switch (kindOf(error)) {
    // ⚠️ Reaching here means the *chain* could not place even one recipient — a list too long is split
    // into legs before this, so this is an input-side overflow: too many UTxOs to spend in one
    // transaction, which is what consolidating fixes.
    case 'too-large':
      return (
        'this wallet’s coins are too scattered to spend in one transaction. Consolidate it first with ' +
        'cardano_buildConsolidation, then send.'
      )
    case 'empty-wallet':
      return 'this wallet has no spendable UTxOs on this network'
    case 'insufficient-funds':
      return 'this wallet does not hold enough for that transfer and its fee'
    case 'value-too-large':
      return 'one output carries more assets than a single output may hold — split it across recipients'
    case 'unsafe-params':
      return 'the protocol parameters the wallet read cannot be trusted, so nothing was built'
    default:
      return `the transaction could not be built: ${reasonOf(error)}`
  }
}

/** The kind a `SendBuildError` declared, or `undefined` for anything else that reached here. */
const kindOf = (error: unknown): SendBuildError['kind'] | undefined =>
  typeof error === 'object' && error !== null && '_tag' in error && error._tag === 'SendBuildError'
    ? (error as SendBuildError).kind
    : undefined

/** ⚠️ `reason` first: these are `Data.TaggedError`s, whose `message` is empty. */
const reasonOf = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'reason' in error) {
    const reason = (error as {reason: unknown}).reason
    if (typeof reason === 'string' && reason !== '') return reason
  }
  return error instanceof Error && error.message !== '' ? error.message : String(error)
}

/**
 * Build a transfer, and carry it to the chain when the call asked for that.
 *
 * `answer` is called exactly once. On the submit path it is called from the review's own callbacks, so
 * the promise this returns resolves as soon as the build is done or the review is open — the agent's
 * wait is held by the approval gate, which bounds it.
 */
/**
 * Which requested assets the given builder cannot carry.
 *
 * A failed holdings read yields no refusals rather than refusing everything: the ordinary builder
 * then reports whatever it actually finds, which is a better answer than declining a send because
 * an unrelated query was down.
 */
const programmableMisroutes = async (
  rail: CardanoRail,
  outputs: readonly {readonly amounts: ReadonlyMap<string, bigint>}[],
  builder: 'ordinary' | 'programmable',
): Promise<readonly string[]> => {
  const holdings = await readOwnProgrammableHoldings(rail, ORIGIN)
  if (holdings.kind !== 'ready') return []
  const programmableIds = new Set(
    holdings.rows.flatMap((row) => row.tokens.map((t) => `${t.policyIdHex}.${t.assetNameHex}`)),
  )
  return misroutedAssets({outputs, programmableIds, builder})
}

export const runAgentTransfer = async (
  params: AgentBuildEnv & {
    readonly intent: ParsedTransfer
    /** Called once with what the agent is told. Absent on the unsigned path, which answers directly. */
    readonly answer: (outcome: LocalToolOutcome) => void
  },
): Promise<void> => {
  const {rail, groupId, intent, answer} = params
  try {
    /**
     * ⚠️ **Refuse a programmable token here, by name, before coin selection sees it.** These sit at
     * the deployment's smart wallet, not in `rail.spendableUtxos`, so the balancer raised
     * `InsufficientError` and the agent was told "this wallet does not hold enough for that transfer
     * and its fee" — false for a token the portfolio was displaying, and an invitation to retry with
     * ever smaller amounts, which can never succeed.
     */
    const misrouted = await programmableMisroutes(rail, intent.outputs, 'ordinary')
    if (misrouted.length > 0) {
      logger.debug('an agent routed a programmable token to the ordinary builder', {
        origin: ORIGIN,
        assets: misrouted,
      })
      answer(refuse(misroutedMessage(misrouted, 'ordinary')))
      return
    }
    const targets = await Effect.runPromise(Effect.either(resolveTargets(rail, intent.outputs)))
    if (targets._tag === 'Left') {
      answer(refuse(targets.left.message))
      return
    }
    const floored = await Effect.runPromise(Effect.either(applyMinAda(rail, intent.outputs, targets.right)))
    if (floored._tag === 'Left') {
      answer(refuse(floored.left.message))
      return
    }
    const buildIntent = {targets: floored.right, ...(intent.memo !== undefined ? {memo: intent.memo} : {})}
    // ⚠️ **A chain, not a single build.** A recipient list too long for one transaction is split across
    // legs that each spend the previous one's change — and *that* is why it cannot be left to the agent
    // to "call again with the rest": until leg one confirms, this wallet has no coins left to build leg
    // two from. Every leg is reviewed in one ceremony. A list that fits comes back as one leg.
    const chained = await Effect.runPromise(Effect.either(buildAgentTransferChain(rail, groupId, buildIntent)))
    if (chained._tag === 'Left') {
      const message = buildFailureMessage(chained.left)
      logger.debug('an agent’s Cardano build did not succeed', {origin: ORIGIN, reason: message})
      answer(refuse(message))
      return
    }
    const {builds, unplaced} = chained.right
    if (builds.length === 0) {
      answer(refuse('nothing could be built for those recipients'))
      return
    }
    logger.debug('built a Cardano transfer for an agent', {
      origin: ORIGIN,
      legs: builds.length,
      unplaced: unplaced.length,
      submit: intent.submit,
    })
    /**
     * ⚠️ Recipients the leg cap could not reach are **named in the answer**, never dropped. Five
     * transactions is a consent limit — one ceremony a person can actually read — and an agent told
     * nothing would report the whole list as paid.
     */
    const shortfall =
      unplaced.length === 0
        ? {}
        : {
            unpaidRecipients: unplaced.length,
            note:
              `${unplaced.length} of the ${intent.outputs.length} recipients did not fit in the ${builds.length} ` +
              'transactions this wallet will approve at once. Pay them with a further call once these have landed.',
          }
    if (!intent.submit) {
      answer(unsignedAnswer(builds, shortfall))
      return
    }
    await openReviewAndSubmit({
      ...params,
      builds,
      handed: (legs) =>
        handedAnswer({
          txHashes: legs.map((l) => l.txHash),
          fee: builds.reduce((sum, b) => sum + b.reviewed.fee, 0n).toString(),
          ...shortfall,
        }),
      answer,
    })
  } catch (error) {
    logger.warn('an agent’s Cardano build threw', {origin: ORIGIN, error: String(error)})
    answer(refuse(`the transaction could not be built: ${String(error)}`))
  }
}

/**
 * Hand a finished build to the review ceremony and answer that it is now with the person.
 *
 * The same shape every other producer uses: one leg, the request the builder already produced (which
 * broadcasts rather than signing only), and the pending overlay registered on the way out so the next
 * build does not re-select inputs this one just spent.
 *
 * ⚠️ **The answer goes out at hand-off, not from the settle callbacks** — see the module note for the
 * race that cost. The callbacks below still do the work that only they can do (the pending overlay, the
 * activity row, the audit trail) and they log what happened; what they no longer do is try to reach a
 * caller whose socket the navigation has since closed.
 */
const openReviewAndSubmit = async (
  params: AgentBuildEnv & {
    /**
     * The transactions to consent to, in submission order.
     *
     * A list rather than one, because a consolidation is several — and they are reviewed in **one
     * ceremony**, which is what makes it a decision a person can actually make. Every other builder
     * passes exactly one.
     */
    readonly builds: readonly AgentBuild[]
    /**
     * Turns the built legs into what the agent is told, once, the moment the review opens.
     *
     * The hashes are the ones these bodies will land under — fixed before signing — so an agent can
     * follow them on chain without being held here for the decision.
     */
    readonly handed: (legs: readonly {readonly txHash: string}[]) => LocalToolOutcome
    readonly answer: (outcome: LocalToolOutcome) => void
    readonly titleKey?: TranslationKey
  },
): Promise<void> => {
  const {rail, groupId, source, env, origin, builds, handed, answer, navigateToReview} = params
  const kind = signerKindOf(source)
  if (!signsAlone(kind)) {
    // A shared or watch-only wallet cannot answer this synchronously — the signatures belong to other
    // people. Refusing is the honest answer; the unsigned build is still available without `submit`.
    answer(refuse('this wallet cannot sign on its own — build without `submit` and have its signers co-sign'))
    return
  }
  const ticketId = registerReviewTicket({
    legs: builds.map((build) => ({reviewed: build.reviewed, request: build.request})),
    groupId,
    // The agent is a dApp for audit purposes, and `origin` says which one. A new purpose would make
    // every existing reader of the audit log incomplete.
    audit: {purpose: 'dapp-tx', origin},
    signingLayer: signingLayerFor(env, rail, kind),
    doneHref: '/wallets',
    ...(params.titleKey !== undefined ? {titleKey: params.titleKey} : {}),
    onSettled: (results) => {
      const submittedAt = Date.now()
      const landed: {txHash: string}[] = []
      results.forEach((result, index) => {
        if (result._tag !== 'TxSubmitted') return
        const build = builds[index]
        if (build === undefined) return
        void Effect.runPromise(rail.pendingTracker.register(pendingTxFrom(result.txHash, build.tracked, submittedAt)))
        // Until the indexer catches up there is no evidence on screen that anything happened.
        registerPendingActivity(rail, result.txHash, build.reviewed, submittedAt)
        recordOutcome({txHash: result.txHash, chain: 'cardano', stage: 'submitted', at: submittedAt})
        landed.push({txHash: result.txHash})
      })
      if (landed.length === 0) {
        // The wallet's own failure, and an agent must be able to tell it from a person declining.
        for (const build of builds) {
          recordOutcome({txHash: build.txHash, chain: 'cardano', stage: 'not-submitted', at: submittedAt})
        }
        logger.warn('an agent’s Cardano transaction was approved but nothing was submitted', {
          origin: ORIGIN,
          of: builds.length,
        })
        return
      }
      logger.debug('an agent’s Cardano transactions were approved and submitted', {
        origin: ORIGIN,
        landed: landed.length,
        of: builds.length,
      })
    },
    onError: (error) => {
      logger.warn('an agent’s Cardano transaction failed after approval', {origin: ORIGIN, error: String(error)})
    },
    // Logged at `debug`: a person declining is an ordinary outcome, not a failure — and the agent was
    // told at hand-off that the decision was theirs.
    onCancel: () => {
      for (const build of builds) {
        recordOutcome({txHash: build.txHash, chain: 'cardano', stage: 'declined', at: Date.now()})
      }
      logger.debug('a person declined an agent’s Cardano transaction', {origin: ORIGIN})
    },
  })
  navigateToReview(ticketId)
  logger.debug('an agent’s Cardano transaction is with the person', {origin: ORIGIN, legs: builds.length})
  // ⚠️ Remembered *before* the answer goes out, so an agent that asks the instant it is told
  // `awaitingApproval` finds the transaction rather than an empty list.
  for (const build of builds) {
    recordOutcome({txHash: build.txHash, chain: 'cardano', stage: 'awaiting-approval', at: Date.now()})
  }
  answer(handed(builds.map((build) => ({txHash: build.txHash}))))
}

/**
 * Mint one asset under this wallet's own policy and hand it out, in one transaction.
 *
 * ⚠️ **A mint cannot be split across transactions the way a payment list can.** Splitting would mint
 * twice under a policy the caller may have asked to lock, so a recipient list that does not fit is
 * refused with the count that does — mint once for those, then pay the rest with a plain transfer out
 * of the remainder this wallet keeps.
 */
export const runAgentMint = async (
  params: AgentBuildEnv & {
    readonly intent: ParsedMint
    readonly answer: (outcome: LocalToolOutcome) => void
  },
): Promise<void> => {
  const {rail, groupId, intent, answer} = params
  try {
    if (intent.lockAfterSlot !== undefined) {
      const tip = await Effect.runPromise(Effect.either(chainTip(rail.chain)))
      if (tip._tag === 'Right' && intent.lockAfterSlot <= tip.right.slot) {
        answer(
          refuse(
            `\`lockAfterSlot\` ${intent.lockAfterSlot} is at or before the current slot ${tip.right.slot}, so the ` +
              'policy would already be closed and the transaction could never be accepted.',
          ),
        )
        return
      }
      // A tip we could not read is not a reason to refuse: the ledger checks the bound itself, and the
      // only thing lost is the earlier, clearer message.
      if (tip._tag === 'Left') {
        logger.warn('could not read the tip to sanity-check a mint lock slot', {
          origin: ORIGIN,
          error: String(tip.left),
        })
      }
    }
    const resolved = await Effect.runPromise(
      Effect.either(
        resolveTargets(
          rail,
          // Only the addresses matter here: what each recipient receives is the mint's, and its
          // min-ADA floor is settled inside the builder.
          intent.recipients.map((r) => ({address: r.address, amounts: new Map(), lovelaceGiven: false})),
        ),
      ),
    )
    if (resolved._tag === 'Left') {
      answer(refuse(resolved.left.message.replace(/^outputs\[/, 'recipients[')))
      return
    }
    const policy = await Effect.runPromise(Effect.either(mintingPolicyFor(rail, intent.lockAfterSlot)))
    if (policy._tag === 'Left') {
      answer(refuse(`the minting policy could not be built: ${String(policy.left)}`))
      return
    }
    const aux = await auxiliaryDataFor(intent, policy.right.policyId)
    if (aux.kind === 'refused') {
      answer(aux.outcome)
      return
    }
    const built = await Effect.runPromise(
      Effect.either(
        buildAgentMint(rail, groupId, {
          assetNameHex: intent.assetNameHex,
          quantity: intent.quantity,
          recipients: resolved.right.map((t, i) => ({
            addressHex: t.addressHex,
            quantity: intent.recipients[i]?.quantity ?? 0n,
          })),
          ...(intent.lockAfterSlot !== undefined ? {lockAfterSlot: intent.lockAfterSlot} : {}),
          ...(aux.kind === 'aux' ? {auxiliaryDataHex: aux.hex} : {}),
        }),
      ),
    )
    if (built._tag === 'Left') {
      answer(refuse(await Effect.runPromise(mintFailureMessage(intent, built.left))))
      return
    }
    logger.debug('built a Cardano mint for an agent', {
      origin: ORIGIN,
      assetId: built.right.assetId,
      recipients: intent.recipients.length,
      submit: intent.submit,
    })
    if (!intent.submit) {
      answer(mintAnswer(built.right, 'unsigned'))
      return
    }
    await openReviewAndSubmit({
      ...params,
      builds: [built.right],
      handed: ([first]) => mintAnswer(built.right, 'handed', first?.txHash),
      answer,
    })
  } catch (error) {
    logger.warn('an agent’s Cardano mint threw', {origin: ORIGIN, error: String(error)})
    answer(refuse(`the mint could not be built: ${String(error)}`))
  }
}

/** The CIP-25 auxiliary data for this mint, if it asked for any, or why it could not be built. */
type AuxOutcome =
  | {readonly kind: 'none'}
  | {readonly kind: 'aux'; readonly hex: string}
  | {readonly kind: 'refused'; readonly outcome: LocalToolOutcome}

const auxiliaryDataFor = async (intent: ParsedMint, policyId: string): Promise<AuxOutcome> => {
  if (intent.metadata === undefined || intent.assetNameText === null) return {kind: 'none'}
  const encoded = await Effect.runPromise(
    Effect.either(cip25AuxiliaryData({policyId, assetName: intent.assetNameText, fields: intent.metadata})),
  )
  if (encoded._tag === 'Left') {
    return {
      kind: 'refused',
      outcome: refuse(`\`metadata\` could not be encoded: ${String((encoded.left as Error).message ?? encoded.left)}`),
    }
  }
  return {kind: 'aux', hex: encoded.right}
}

const mintAnswer = (built: AgentMint, stage: 'unsigned' | 'handed', txHash?: string): LocalToolOutcome => {
  const mint = {
    policyId: built.policyId,
    assetId: built.assetId,
    txHash: txHash ?? built.txHash,
    fee: built.reviewed.fee.toString(),
  }
  return stage === 'handed'
    ? handedAnswer(mint)
    : {ok: true, value: {submitted: false, ...mint, txHex: built.unsignedTxHex}}
}

/** A mint that does not fit cannot be split — it can only be told how many would fit. */
const mintFailureMessage = (intent: ParsedMint, error: unknown): Effect.Effect<string> =>
  Effect.sync(() => {
    const kind = kindOf(error)
    if (kind === 'too-large') {
      return (
        `these ${intent.recipients.length} recipients do not fit in one transaction, and a mint cannot be split ` +
        'across two without minting twice. Mint to fewer recipients and pay the rest with cardano_buildTransfer ' +
        'out of what this wallet keeps.'
      )
    }
    if (kind === 'insufficient-funds') {
      return 'this wallet does not hold enough ADA for the min-ADA every recipient’s output needs, plus the fee'
    }
    if (kind === 'empty-wallet') return 'this wallet has no spendable UTxOs on this network'
    return `the mint could not be built: ${reasonOf(error)}`
  })

/**
 * Delegate this account's stake, its vote, or both.
 *
 * ⚠️ **A DRep id is parsed here rather than passed through.** `parseDRepTarget` accepts the bech32
 * forms and the two literals and answers `null` for anything else — including a *pool* id, which is
 * bech32 and would otherwise reach the certificate builder as 28 bytes it would happily delegate to.
 */
export const runAgentDelegation = async (
  params: AgentBuildEnv & {
    readonly intent: ParsedDelegation
    readonly answer: (outcome: LocalToolOutcome) => void
  },
): Promise<void> => {
  const {rail, groupId, source, intent, answer} = params
  try {
    let drep: DRepTarget | null = null
    if (intent.drep !== null) {
      drep = parseDRepTarget(intent.drep)
      if (drep === null) {
        answer(
          refuse(
            `\`drep\` is not a DRep id: ${intent.drep}. Use a bech32 drep id, or the literal "abstain" or ` +
              '"no_confidence".',
          ),
        )
        return
      }
    }
    const built = await Effect.runPromise(
      Effect.either(buildAgentDelegation(rail, groupId, {pool: intent.pool, drep}, signerKindOf(source))),
    )
    if (built._tag === 'Left') {
      answer(refuse(delegationFailureMessage(built.left)))
      return
    }
    logger.debug('built a Cardano delegation for an agent', {
      origin: ORIGIN,
      pool: intent.pool,
      drep: intent.drep,
      submit: intent.submit,
    })
    if (!intent.submit) {
      answer(unsignedAnswer([built.right]))
      return
    }
    await openReviewAndSubmit({
      ...params,
      builds: [built.right],
      handed: ([first]) => handedAnswer({txHash: first?.txHash, fee: built.right.reviewed.fee.toString()}),
      answer,
    })
  } catch (error) {
    logger.warn('an agent’s Cardano delegation threw', {origin: ORIGIN, error: String(error)})
    answer(refuse(`the delegation could not be built: ${String(error)}`))
  }
}

const delegationFailureMessage = (error: unknown): string => {
  const kind = typeof error === 'object' && error !== null && 'kind' in error ? (error as {kind: unknown}).kind : null
  if (kind === 'nothing-to-do') {
    return 'this account is already delegated exactly that way, so there is nothing to sign'
  }
  if (kind === 'unavailable') {
    return 'this wallet has no stake credential — an address-only wallet has no account to delegate'
  }
  if (kind === 'empty-wallet') return 'this wallet has no spendable UTxOs on this network'
  if (kind === 'insufficient-funds') {
    return 'this wallet does not hold enough for the fee, and the deposit if the stake key is not registered yet'
  }
  return `the delegation could not be built: ${reasonOf(error)}`
}

/**
 * Fold this wallet's small UTxOs together.
 *
 * ⚠️ **Several transactions, reviewed in one ceremony.** A fold is bounded by transaction size, so a
 * scattered wallet needs more than one — and they are independent, each consuming its own disjoint
 * slice, so leg two is valid whether or not leg one lands.
 *
 * ⚠️ **What it could not take is reported, never implied.** UTxOs held back by policy and candidates
 * left over at the leg cap are two different facts, and a summary that mentioned neither would read as
 * "your wallet is now consolidated" when it is not.
 */
export const runAgentConsolidation = async (
  params: AgentBuildEnv & {
    readonly intent: ParsedConsolidation
    readonly answer: (outcome: LocalToolOutcome) => void
  },
): Promise<void> => {
  const {rail, groupId, intent, answer} = params
  try {
    const stored = await loadWalletOptimization()
    const policy: WalletOptimization = {
      ...stored,
      ...(intent.withdrawRewards !== undefined ? {autoWithdrawRewards: intent.withdrawRewards} : {}),
      ...(intent.bundleByPolicy !== undefined ? {bundleByPolicy: intent.bundleByPolicy} : {}),
      ...(intent.keepPureAdaOutput !== undefined ? {keepPureAdaOutput: intent.keepPureAdaOutput} : {}),
      ...(intent.maxInputsPerTx !== undefined ? {maxInputsPerTx: intent.maxInputsPerTx} : {}),
    }
    const planned = await Effect.runPromise(Effect.either(buildConsolidation(rail, groupId, policy)))
    if (planned._tag === 'Left') {
      answer(refuse(consolidationFailureMessage(planned.left)))
      return
    }
    const outcome = planned.right
    const builds = await Effect.runPromise(
      Effect.either(Effect.forEach(outcome.legs, (leg) => agentBuildFrom(leg.review))),
    )
    if (builds._tag === 'Left') {
      answer(refuse(`the consolidation was planned but could not be assembled: ${reasonOf(builds.left)}`))
      return
    }
    const summary = consolidationSummary(outcome)
    logger.debug('planned a Cardano consolidation for an agent', {origin: ORIGIN, ...summary, submit: intent.submit})
    if (!intent.submit) {
      answer({
        ok: true,
        value: {submitted: false, ...summary, transactions: builds.right.map(unsignedLeg)},
      })
      return
    }
    await openReviewAndSubmit({
      ...params,
      builds: builds.right,
      titleKey: 'consolidate.reviewTitle',
      handed: (legs) => handedAnswer({...summary, txHashes: legs.map((l) => l.txHash)}),
      answer,
    })
  } catch (error) {
    logger.warn('an agent’s Cardano consolidation threw', {origin: ORIGIN, error: String(error)})
    answer(refuse(`the consolidation could not be planned: ${String(error)}`))
  }
}

const unsignedLeg = (build: AgentBuild) => ({
  txHex: build.unsignedTxHex,
  txHash: build.txHash,
  fee: build.reviewed.fee.toString(),
})

/**
 * What the fold will do, and — as importantly — what it will leave alone.
 *
 * `excluded` and `remaining` are different facts: the first was refused by policy, the second simply had
 * no room. Both are named so the agent can say which, instead of implying the wallet is finished.
 */
const consolidationSummary = (outcome: ConsolidationOutcome) => ({
  transactionCount: outcome.legs.length,
  utxosBefore: outcome.utxosBefore,
  utxosAfter: outcome.utxosAfter,
  totalFee: outcome.totalFee.toString(),
  withdrawnRewards: outcome.withdrawnRewards.toString(),
  excludedByPolicy: outcome.excluded.length,
  leftUnfolded: outcome.remaining.length,
  stoppedBecause: outcome.stop,
})

const consolidationFailureMessage = (error: unknown): string => {
  const kind = typeof error === 'object' && error !== null && 'kind' in error ? (error as {kind: unknown}).kind : null
  if (kind === 'nothing-to-do') {
    return 'there is nothing worth folding here — a consolidation that does not reduce the UTxO count would charge a fee to change nothing'
  }
  if (kind === 'empty-wallet') return 'this wallet has no spendable UTxOs on this network'
  return `the consolidation could not be planned: ${reasonOf(error)}`
}

/**
 * Publish a script as a reference input.
 *
 * ⚠️ **The address defaults to this wallet's own**, and that is the only safe default: a reference UTxO
 * sent anywhere else is one this wallet cannot recover, and sending it to the *script's own* address
 * would lock the ADA behind the very validator being published.
 */
export const runAgentDeploy = async (
  params: AgentBuildEnv & {
    readonly intent: ParsedDeploy
    readonly answer: (outcome: LocalToolOutcome) => void
  },
): Promise<void> => {
  const {rail, groupId, intent, answer} = params
  try {
    let addressHex = rail.account.addressHex
    if (intent.address !== null) {
      const resolved = await Effect.runPromise(
        Effect.either(resolveTargets(rail, [{address: intent.address, amounts: new Map(), lovelaceGiven: false}])),
      )
      if (resolved._tag === 'Left') {
        answer(refuse(resolved.left.message.replace('outputs[0].address', '`address`')))
        return
      }
      addressHex = AddressHex(resolved.right[0]?.addressHex ?? addressHex)
    }
    const built = await Effect.runPromise(
      Effect.either(
        buildAgentDeploy(rail, groupId, {
          version: intent.version,
          scriptHex: intent.scriptHex,
          addressHex,
          ...(intent.datumHex !== undefined ? {datumHex: intent.datumHex} : {}),
          ...(intent.lovelace !== undefined ? {lovelace: intent.lovelace} : {}),
        }),
      ),
    )
    if (built._tag === 'Left') {
      answer(refuse(deployFailureMessage(built.left)))
      return
    }
    const deployed = built.right
    logger.debug('built a Cardano script deployment for an agent', {
      origin: ORIGIN,
      version: intent.version,
      lockedLovelace: deployed.lockedLovelace.toString(),
      submit: intent.submit,
    })
    if (!intent.submit) {
      answer({
        ok: true,
        value: {
          submitted: false,
          txHex: deployed.unsignedTxHex,
          txHash: deployed.txHash,
          fee: deployed.reviewed.fee.toString(),
          lockedLovelace: deployed.lockedLovelace.toString(),
        },
      })
      return
    }
    await openReviewAndSubmit({
      ...params,
      builds: [deployed],
      handed: ([first]) =>
        handedAnswer({
          txHash: first?.txHash,
          fee: deployed.reviewed.fee.toString(),
          lockedLovelace: deployed.lockedLovelace.toString(),
          // The reference is the transaction's first output; a spender points at it by outpoint.
          referenceInput: {txHash: first?.txHash, index: 0},
        }),
      answer,
    })
  } catch (error) {
    logger.warn('an agent’s Cardano script deployment threw', {origin: ORIGIN, error: String(error)})
    answer(refuse(`the script could not be published: ${String(error)}`))
  }
}

const deployFailureMessage = (error: unknown): string => {
  const kind = kindOf(error)
  if (kind === 'insufficient-funds') {
    return 'this wallet does not hold enough ADA to lock beside the script — a reference output’s minimum grows with the script’s size'
  }
  if (kind === 'empty-wallet') return 'this wallet has no spendable UTxOs on this network'
  if (kind === 'too-large') return 'the script is too large to publish in one transaction'
  return `the script could not be published: ${reasonOf(error)}`
}

// ── co-funding: one transaction several wallets pay for ──

/** One granted scope, opened. The co-funding tools reach across scopes, so they take the whole set. */
export type GrantedScope = {
  readonly key: string
  readonly rail: CardanoRail
  readonly groupId: string
  readonly accountIndex: number
  readonly name: string
  readonly source: string | undefined
}

/**
 * Build a co-funded send: several wallets' inputs, one transaction, one set of recipients.
 *
 * **The send funnel's own builder, unchanged.** `buildCoFundedSend` gathers each party's UTxOs,
 * composes the body with every contributor's return as an *explicit output*, and files the envelope
 * for co-signing — which is what the Send screen does with the same call. Nothing about co-funding is
 * re-implemented here; this only turns granted scopes into the sources it takes.
 *
 * ⚠️ **Only granted scopes may contribute**, and that is the whole authority boundary. A wallet the
 * person did not put in the agent's scope list cannot be named as a source, so an agent cannot spend
 * from a wallet it was never given.
 *
 * ⚠️ **The composer pays the fee**, because a plan has one change address and it is theirs. Every other
 * contributor's return is exact, and a contribution that does not add up is refused rather than
 * absorbed — the surplus would land in the composer's change, which is somebody else's money moving
 * somewhere nobody chose.
 */
export const runAgentCoFundedSend = async (
  params: AgentBuildEnv & {
    readonly intent: ParsedCoFund
    /** Every scope the person granted, so a source can be resolved to a wallet. */
    readonly granted: ReadonlyMap<string, GrantedScope>
    /** The composer — the scope this call was addressed to. */
    readonly composerKey: string
    readonly addressesOf: (groupId: string) => Promise<readonly string[]>
    readonly answer: (outcome: LocalToolOutcome) => void
  },
): Promise<void> => {
  const {rail, groupId, intent, granted, composerKey, answer} = params
  try {
    const composer = granted.get(composerKey)
    if (composer === undefined) {
      answer(refuse('the composing wallet could not be opened on this device'))
      return
    }
    const sources: CoFundSource[] = []
    for (const source of intent.sources) {
      const scope = granted.get(source.scope)
      if (scope === undefined) {
        answer(
          refuse(
            `\`sources\` names the scope '${source.scope}', which this wallet has not granted. ` +
              `Granted: ${[...granted.keys()].join(', ')}.`,
          ),
        )
        return
      }
      sources.push({
        groupId: scope.groupId,
        name: scope.name,
        isComposer: scope.key === composerKey,
        lovelace: source.amounts.get('') ?? 0n,
        assets: new Map([...source.amounts].filter(([id]) => id !== '')),
      })
    }
    if (!sources.some((s) => s.isComposer)) {
      answer(
        refuse(
          `\`sources\` must include the composing wallet '${composerKey}' — it owns the change and pays ` +
            'the fee, so it has to be one of the contributors. Address the call to a different scope to ' +
            'compose from that wallet instead.',
        ),
      )
      return
    }
    const targets = await Effect.runPromise(Effect.either(resolveTargets(rail, intent.outputs)))
    if (targets._tag === 'Left') {
      answer(refuse(targets.left.message))
      return
    }
    const built = await buildCoFundedSend({
      rail,
      groupId,
      name: composer.name,
      sources,
      targets: targets.right,
      addressesOf: params.addressesOf,
      now: new Date().toISOString(),
    })
    if (!built.ok) {
      answer(refuse(coFundRefusal(built)))
      return
    }
    const filed = await Effect.runPromise(Effect.either(platformCosignRegistry().get(built.pendingId)))
    const envelope = filed._tag === 'Right' ? (filed.right?.envelope ?? null) : null
    if (envelope === null) {
      // The build persisted it, so this is a storage read failing under us rather than a missing file.
      // Answering with the id alone would leave the agent holding a handle to something it cannot see.
      logger.warn('a co-funded envelope was filed but could not be read back', {
        origin: ORIGIN,
        pendingId: built.pendingId,
      })
      answer(refuse('the transaction was built but could not be read back from this device’s storage'))
      return
    }
    logger.debug('built a co-funded send for an agent', {
      origin: ORIGIN,
      pendingId: built.pendingId,
      sources: sources.length,
    })
    answer({ok: true, value: {pendingId: built.pendingId, ...envelopeStatus(envelope, granted)}})
  } catch (error) {
    logger.warn('an agent’s co-funded send threw', {origin: ORIGIN, error: String(error)})
    answer(refuse(`the co-funded transaction could not be built: ${String(error)}`))
  }
}

/**
 * Who has signed, who has not, and which of the outstanding ones this device can answer.
 *
 * ⚠️ **`scope` is `null` for a signer this device cannot sign as**, and saying so is the point: an agent
 * that cannot tell "waiting for someone else" from "waiting for you" either stalls on a signature that
 * will never come from here, or reports a transaction as stuck when it is one call from going out.
 */
const envelopeStatus = (envelope: TxEnvelope, granted: ReadonlyMap<string, GrantedScope>) => {
  const byKeyHash = new Map<string, string>()
  for (const [key, scope] of granted) {
    for (const hash of paymentKeyHashesOf(scope.rail)) if (!byKeyHash.has(hash)) byKeyHash.set(hash, key)
  }
  const signers = envelope.signers.map((signer) => ({
    name: signer.name,
    signed: signer.signed,
    scope: byKeyHash.get(signer.keyHashHex.toLowerCase()) ?? null,
  }))
  const status = statusOf(envelope, requiredFor(envelope))
  return {
    bodyHex: envelope.bodyHex,
    signed: status.signed,
    required: status.required,
    signers,
    /** The scopes that still owe a signature and can give it here — the agent's work list. */
    awaitingHere: signers.filter((s) => !s.signed && s.scope !== null).map((s) => s.scope),
  }
}

/** Every payment key hash this rail can witness with, lowercased for roster matching. */
const paymentKeyHashesOf = (rail: CardanoRail): readonly string[] =>
  [rail.account.paymentKeyHashHex, ...rail.account.keyRegistry.map((k) => k.keyHashHex)]
    .filter((h): h is string => typeof h === 'string' && h.length > 0)
    .map((h) => h.toLowerCase())

/**
 * The composer's arithmetic refusal, **naming the party**.
 *
 * A flat "could not build" hides the one thing the caller can act on: which contributor to adjust, and
 * by how much. The screen has `coFundFailureMessage` for this; it takes a `t`, and an agent is not
 * reading a localised string — so this says the same things in the same order, in English.
 */
const composeRefusal = (failure: ComposeFailure): string => {
  switch (failure.kind) {
    case 'single-contributor':
      return 'only one wallet contributes — that is an ordinary transfer, so use cardano_buildTransfer'
    case 'no-composer':
    case 'multiple-composers':
      return 'exactly one contributor must be the composing wallet, and it is the scope this call names'
    case 'composer-has-no-inputs':
      return 'the composing wallet has no inputs to spend, and it owns the change and pays the fee'
    case 'party-has-no-inputs':
      return `${failure.name} has no readable UTxOs to contribute`
    case 'zero-contribution':
      return `${failure.name} contributes nothing while still owing a signature — leave it out`
    case 'contribution-exceeds-inputs':
      return (
        `${failure.name} was asked for ${failure.requested.lovelace} lovelace but holds ` +
        `${failure.available.lovelace}`
      )
    case 'return-below-min-ada':
      return (
        `${failure.name} cannot both contribute that much and keep its return above the ${failure.minimum} ` +
        `lovelace minimum an output needs — it would be left with ${failure.returned}. Ask it for less.`
      )
    case 'duplicate-input':
      return `two contributors both offered ${failure.txHash}#${failure.index}; one of their address sets is wrong`
  }
}

/** The co-fund builder's own refusal, in a sentence rather than a tag. */
const coFundRefusal = (result: Extract<CoFundResult, {ok: false}>): string => {
  if ('compose' in result) return composeRefusal(result.compose)
  switch (result.reason) {
    case 'unbalanced':
      return (
        `the wallets put in ${result.contributed} lovelace and the recipients ask for ${result.requested}. ` +
        'They have to match exactly: a surplus would land in the composer’s change, which is somebody ' +
        'else’s money moving somewhere nobody chose.'
      )
    case 'unbalanced-tokens':
      return `the wallets and the recipients disagree on ${result.assetIds.join(', ')} — every token put in must reach an output`
    case 'shared-wallet':
      return `${result.name} is a shared wallet, whose spend needs a script this transaction cannot carry. Send from it separately.`
    case 'composer-empty':
      return 'the composing wallet has no readable UTxOs, so it cannot own the change or pay the fee'
    case 'unreadable-wallet':
      return 'one of the contributing wallets could not be read on this device'
    case 'too-large':
      return 'the transaction is over the size limit — the contributing wallets may need consolidating first'
    default:
      return `the co-funded transaction could not be built: ${result.detail ?? 'unknown reason'}`
  }
}

/**
 * Add one wallet's signature to a co-funded transaction, and send it once the last one is in.
 *
 * **The co-sign screen's own path, driven from a call instead of a button.** `partialSignRequest` is an
 * ordinary `signOnly` request, so the review screen signs exactly the bytes it rendered and hands back
 * this signer's witness set; merging, the quorum check and the submit are what happens after, exactly
 * as `CoSignScreen` does them.
 *
 * ⚠️ **Signing is per wallet, so the agent calls this once per contributor.** Each one is a separate
 * decision on the device — that is what co-funding *is* — and a tool that signed for everybody at once
 * would be asking one person to consent on behalf of the others.
 *
 * ⚠️ **The last signature submits.** Every signer reviewed the same body, so the quorum being met is
 * the authorisation; a further approval to broadcast would be asking again for something already given.
 */
export const runAgentCoSign = async (
  params: AgentBuildEnv & {
    readonly intent: ParsedCoSign
    /** The scope whose signature this adds — the one the call was addressed to. */
    readonly signer: GrantedScope
    readonly granted: ReadonlyMap<string, GrantedScope>
    readonly answer: (outcome: LocalToolOutcome) => void
    readonly navigateToReview: (ticketId: string) => void
  },
): Promise<void> => {
  const {intent, signer, granted, answer} = params
  const registry = platformCosignRegistry()
  try {
    const filed = await Effect.runPromise(Effect.either(registry.get(intent.pendingId)))
    const pending = filed._tag === 'Right' ? filed.right : null
    if (pending === null) {
      answer(refuse(`no co-funded transaction is filed under '${intent.pendingId}' on this device`))
      return
    }
    const envelope = pending.envelope
    const status = statusOf(envelope, requiredFor(envelope))
    if (status.signed >= status.required) {
      // Already complete: submit it rather than asking for a signature that would count toward nothing.
      await submitCoFunded({...params, envelope, registry, answer})
      return
    }
    // ⚠️ The **signer's own rail**, not the composer's. A multiparty envelope names separate wallets and
    // each resolves the inputs it owns; resolving against another wallet's spendable set returns paths
    // for none of them, or worse for the wrong ones.
    const resolvePaths = () =>
      Effect.runPromise(
        Effect.either(
          createCardanoTxContext(signer.rail).resolveSigningPaths(
            envelope.bodyHex,
            signer.groupId,
            envelope.accountIndex,
          ),
        ),
      )
    let resolved = await resolvePaths()
    if (resolved._tag === 'Right' && resolved.right.signingPaths.length === 0) {
      // ⚠️ **A contributor's own wallet may not have seen the coin it is contributing.** The composer
      // gathers every party's UTxOs through *its* rail — a read by address — so a build can legitimately
      // select an input the contributor's wallet has never synced. Resolving paths reads that
      // contributor's own spendable set, which then holds nothing matching, and the honest-looking
      // refusal below ("owns none of this transaction's inputs") names a cause that is not true: the
      // wallet owns the coin, it just had not looked. Measured on preprod: a co-funded build named both
      // signers, the second refused, and switching to that wallet in the app so it synced was enough to
      // make the same signature succeed.
      //
      // So a signer syncs before it is allowed to refuse. Only on this path, so a signature that
      // resolves immediately pays nothing for it.
      logger.debug('an agent’s co-sign found no path; syncing the signer before refusing', {
        origin: ORIGIN,
        scope: signer.key,
      })
      await Effect.runPromise(
        signer.rail.sync.pipe(
          Effect.catchAll((error) => {
            logger.warn('the signer’s rail could not be synced before co-signing', {
              origin: ORIGIN,
              scope: signer.key,
              error: String(error),
            })
            return Effect.void
          }),
        ),
      )
      resolved = await resolvePaths()
    }
    if (resolved._tag === 'Left' || resolved.right.signingPaths.length === 0) {
      // Two causes, and they call for different things. Either this wallet's share has already been
      // spent elsewhere, or it owns none of this body's inputs — a scope that is simply not a party.
      const spent = await Effect.runPromise(
        spentInputCountOf(signer.rail, envelope.bodyHex).pipe(Effect.provideService(Decode, signer.rail.decode)),
      )
      logger.warn('an agent’s co-sign could not resolve any signing path', {
        origin: ORIGIN,
        pendingId: intent.pendingId,
        scope: signer.key,
        spentInputs: spent,
      })
      answer(
        refuse(
          spent > 0
            ? `${spent} of this transaction's inputs have already been spent elsewhere, so it can no longer go out`
            : `${signer.name} owns none of this transaction's inputs, so it has no signature to give`,
        ),
      )
      return
    }
    const reviewed = await reviewEnvelope(signer.rail, envelope)
    if (reviewed === null) {
      answer(refuse('the transaction could not be decoded for review, so nothing was signed'))
      return
    }
    const kind = signerKindOf(signer.source)
    if (!signsAlone(kind)) {
      answer(
        refuse(
          `${signer.name} cannot sign on its own — a shared wallet's share has to be co-signed by its own signers`,
        ),
      )
      return
    }
    let answered = false
    const settle = (outcome: LocalToolOutcome) => {
      if (answered) return
      answered = true
      answer(outcome)
    }
    const ticketId = registerReviewTicket({
      legs: [{reviewed, request: partialSignRequest(envelope, signer.groupId, resolved.right.signingPaths)}],
      groupId: signer.groupId,
      audit: {purpose: 'cosign', origin: params.origin},
      signingLayer: signingLayerFor(params.env, signer.rail, kind),
      titleKey: 'cosign.title',
      signatureStatus: status,
      signerName: signer.name,
      // Stays put: a co-signed transaction is not finished when one signature lands.
      doneHref: null,
      onSettled: (results) => {
        const result = results.length === 1 ? results[0] : undefined
        if (result?._tag !== 'TxSignedOnly') {
          settle(refuse('the wallet did not produce a signature'))
          return
        }
        void mergeAndMaybeSubmit({...params, envelope, registry, witnessSetHex: result.witnessSetHex, answer: settle})
      },
      onError: (error) => settle(refuse(`the signature failed: ${String(error)}`)),
      onCancel: () => settle(refuse(`${signer.name} declined on the device`)),
    })
    params.navigateToReview(ticketId)
  } catch (error) {
    logger.warn('an agent’s co-sign threw', {origin: ORIGIN, error: String(error)})
    answer(refuse(`the signature could not be added: ${String(error)}`))
  }
  void granted
}

/**
 * The review IR for a body this wallet did not necessarily build.
 *
 * ⚠️ **Own coins for our own inputs, the chain for everyone else's.** Resolving only from our spendable
 * set leaves another party's inputs unread, and their outputs then look like money arriving from
 * nowhere — which is exactly the shape a person should not be shown, and exactly the shape an agent
 * would describe wrongly.
 *
 * Answers `null` when the bytes cannot be reviewed at all: a different fact from a transaction that
 * does nothing, and one no caller may paper over.
 */
const reviewForAgent = (
  rail: CardanoRail,
  bodyHex: string,
  auxHex: string | undefined,
): Effect.Effect<ReviewedTransaction | null> =>
  Effect.gen(function* () {
    const built = yield* Effect.either(
      Effect.gen(function* () {
        const params = yield* rail.protocolParams
        const own = yield* Effect.flatMap(rail.spendableUtxos, (utxos) => resolvedInputsFromSpendable(utxos)).pipe(
          Effect.orElseSucceed(() => [] as readonly ResolvedInput[]),
        )
        const resolvedInputs = yield* resolveInputsWithChain(rail, bodyHex, own).pipe(
          Effect.provideService(Decode, rail.decode),
        )
        return yield* reviewCardanoTx(
          bodyHex,
          rail.account.walletContext,
          resolvedInputs,
          params,
          undefined,
          undefined,
          auxHex,
        ).pipe(Effect.provideService(Decode, rail.decode))
      }),
    )
    if (built._tag === 'Left') {
      logger.warn('a transaction could not be reviewed', {origin: ORIGIN, error: String(built.left)})
      return null
    }
    return built.right
  })

/** The co-sign screen's own call, over the envelope it holds. */
const reviewEnvelope = (rail: CardanoRail, envelope: TxEnvelope) =>
  Effect.runPromise(reviewForAgent(rail, envelope.bodyHex, envelope.auxHex))

/** Merge the new witness in, keep it filed, and submit when that was the last one owed. */
const mergeAndMaybeSubmit = async (params: {
  readonly signer: GrantedScope
  readonly granted: ReadonlyMap<string, GrantedScope>
  readonly envelope: TxEnvelope
  readonly registry: ReturnType<typeof platformCosignRegistry>
  readonly witnessSetHex: string
  readonly answer: (outcome: LocalToolOutcome) => void
}): Promise<void> => {
  const {signer, envelope, registry, witnessSetHex, answer} = params
  const witnesses = await Effect.runPromise(envelopeWitnessesFrom(witnessSetHex))
  const signed = witnesses.reduce<TxEnvelope>((env, w) => addSignature(env, w), envelope)
  await Effect.runPromise(
    Effect.ignore(registry.save({id: stableCosignId(signed), groupId: signer.groupId, envelope: signed})),
  )
  const status = statusOf(signed, requiredFor(signed))
  logger.debug('an agent added a signature to a co-funded transaction', {
    origin: ORIGIN,
    scope: signer.key,
    signed: status.signed,
    required: status.required,
  })
  if (status.signed < status.required) {
    answer({
      ok: true,
      value: {
        pendingId: stableCosignId(signed),
        submitted: false,
        ...envelopeStatus(signed, params.granted),
      },
    })
    return
  }
  await submitCoFunded({...params, envelope: signed})
}

/** Broadcast a co-funded transaction whose quorum is met, and make the wallet act like it. */
const submitCoFunded = async (params: {
  readonly signer: GrantedScope
  readonly granted: ReadonlyMap<string, GrantedScope>
  readonly envelope: TxEnvelope
  readonly registry: ReturnType<typeof platformCosignRegistry>
  readonly answer: (outcome: LocalToolOutcome) => void
}): Promise<void> => {
  const {signer, envelope, registry, answer} = params
  const sent = await Effect.runPromise(Effect.either(submitEnvelope(signer.rail, envelope)))
  if (sent._tag === 'Left') {
    logger.warn('a co-funded transaction met its quorum but could not be submitted', {
      origin: ORIGIN,
      error: String(sent.left),
    })
    answer(refuse(`every signature is in but the transaction could not be sent: ${sent.left.message}`))
    return
  }
  await Effect.runPromise(Effect.ignore(registry.remove(stableCosignId(envelope))))
  // ⚠️ Lock the spent inputs. Without it the wallet keeps offering coins it has already spent, and the
  // next send is rejected as a double spend with nothing saying why.
  await Effect.runPromise(
    consumedUtxoIdsOf(envelope.bodyHex).pipe(
      Effect.provideService(Decode, signer.rail.decode),
      Effect.flatMap((consumedUtxoIds) =>
        signer.rail.pendingTracker.register({txHash: sent.right, consumedUtxoIds, change: [], submittedAt: Date.now()}),
      ),
      Effect.catchAll((e) => {
        logger.warn('a co-funded transaction was submitted but not tracked', {origin: ORIGIN, error: String(e)})
        return Effect.void
      }),
    ),
  )
  logger.debug('an agent’s co-funded transaction went out', {origin: ORIGIN, txHash: sent.right})
  answer({ok: true, value: {submitted: true, txHash: sent.right, ...envelopeStatus(envelope, params.granted)}})
}

/**
 * Describe a transaction from this wallet's point of view, for an agent holding bytes it did not build.
 *
 * ⚠️ **The same review the person will see**, projected — `reviewEnvelope`'s inputs resolution, own
 * coins for our own and the chain for everyone else's, so the other parties' outputs do not read as
 * money arriving from nowhere. An agent describing a transaction from anything less is guessing.
 */
export const describeAgentTransaction = (
  rail: CardanoRail,
  txHex: string,
): Effect.Effect<ReturnType<typeof describeTransaction>, Error> =>
  Effect.gen(function* () {
    // A full transaction or a bare body: an agent is handed both, by dApps and by files, and refusing
    // one of them would be a distinction it has no way to make.
    const bodyHex = yield* Effect.orElseSucceed(Inspect.txBodyFromTx(txHex), () => txHex)
    const auxHex = yield* Effect.orElseSucceed(Inspect.auxFromTx(txHex), () => '')
    const reviewed = yield* reviewForAgent(rail, bodyHex, auxHex === '' ? undefined : auxHex)
    if (reviewed === null) return yield* Effect.fail(new Error('not a transaction this wallet can decode'))
    return describeTransaction(reviewed)
  })

/**
 * Build a CIP-113 programmable-token transfer for an agent, and carry it to the chain when asked.
 *
 * ⚠️ **Its own tool, not a flag on `cardano_buildTransfer`.** A programmable token is spent from the
 * deployment's smart wallet through a Plutus dispatch, not from the wallet's own UTxOs by ordinary
 * coin selection — different inputs, a different builder, its own review. The two refuse each
 * other's assets rather than splitting a basket between them.
 */
export const runAgentProgrammableTransfer = async (
  params: AgentBuildEnv & {
    readonly intent: ParsedProgrammableTransfer
    readonly answer: (outcome: LocalToolOutcome) => void
  },
): Promise<void> => {
  const {rail, groupId, intent, answer} = params
  try {
    const misrouted = await programmableMisroutes(rail, intent.outputs, 'programmable')
    if (misrouted.length > 0) {
      answer(refuse(misroutedMessage(misrouted, 'programmable')))
      return
    }
    const selection = selectCip113Deployment({protocolMagic: rail.config.protocolMagic})
    if (selection.kind !== 'active') {
      answer(
        refuse(
          selection.kind === 'misconfigured'
            ? `the CIP-113 deployment for this network is misconfigured: ${selection.detail}`
            : 'this network has no CIP-113 deployment, so it has no programmable tokens to send',
        ),
      )
      return
    }
    const {deployment} = selection

    /**
     * ⚠️ One intent per (recipient, asset), never the basket total — and a single recipient who
     * cannot hold a programmable token refuses the WHOLE build, named. Paying three of the four
     * asked for, silently, is the failure `intents.ts` exists to prevent.
     */
    const build = programmableIntents(
      intent.outputs.map((o) => ({address: o.address, amounts: o.amounts})),
      requestedAssetIds(intent.outputs),
      (address) => resolveProgrammableRecipient(address, deployment, rail.config.networkId),
    )
    if (build.kind === 'refused') {
      answer(refuse(`${build.address}: ${build.detail}`))
      return
    }
    if (build.kind === 'empty') {
      answer(refuse('no recipient was allocated any of those assets'))
      return
    }

    const built = await Effect.runPromise(
      buildProgrammableTransfer(rail, groupId, build.intents).pipe(Effect.provide(cardanoRailLayer(rail.config))),
    )
    if (built.kind === 'refused') {
      logger.debug('an agent’s programmable transfer was refused', {
        origin: ORIGIN,
        reason: built.reason,
        detail: built.detail,
      })
      answer(refuse(built.detail))
      return
    }

    const protocolParams = await Effect.runPromise(rail.protocolParams)
    const reviewed = await Effect.runPromise(
      reviewCardanoTx(
        built.bodyHex,
        // ⚠️ The deployment's programmable-logic script is a *shared* payment credential: ours only
        // over our own stake key. Without naming it the review reads a smart-wallet input as
        // somebody else's, and the transfer renders as pure gain.
        {
          ...rail.account.walletContext,
          sharedPaymentScriptHashes: new Set([deployment.plbScriptHashHex.toLowerCase()]),
        },
        // ⚠️ The smart-wallet UTxOs are not in the wallet's own set, so nothing downstream can
        // resolve them; without these the inputs render as unattributed outpoints.
        built.resolvedInputs,
        protocolParams,
      ).pipe(Effect.provideService(Decode, rail.decode)),
    )

    // ⚠️ The ordinary change, tracked like any other send's. Left empty, the pending overlay removed
    // the funding inputs and put nothing back, so the wallet under-reported its own balance until the
    // transfer confirmed — 12 ada displayed against a real 27,327.
    const change = await Effect.runPromise(changeUtxosFromPlan(rail, built.changeOutputs))
    const agentBuild = await Effect.runPromise(
      agentBuildFrom({
        reviewed,
        bodyHex: built.bodyHex,
        request: built.request,
        tracked: {consumedUtxoIds: built.resolvedInputs.map((i) => `${i.txHashHex}:${i.index}`), change},
      }),
    )
    logger.debug('built a programmable transfer for an agent', {
      origin: ORIGIN,
      intents: build.intents.length,
      inputs: built.resolvedInputs.length,
      submit: intent.submit,
    })
    if (!intent.submit) {
      answer(unsignedAnswer([agentBuild]))
      return
    }
    await openReviewAndSubmit({
      ...params,
      builds: [agentBuild],
      titleKey: 'cardanoSend.programmableTitle',
      handed: (legs) => handedAnswer({txHashes: legs.map((l) => l.txHash), fee: agentBuild.reviewed.fee.toString()}),
      answer,
    })
  } catch (error) {
    logger.warn('an agent’s programmable transfer threw', {origin: ORIGIN, error: String(error)})
    answer(refuse(`the transfer could not be built: ${reasonOf(error)}`))
  }
}
