/**
 * The Midnight **builders** an agent can drive, as functions any surface can call.
 *
 * A sibling of `./midnight-signing.ts` rather than part of it: that module is the connector's write
 * path — the three CIP methods a page can call — while these are tools the app answers itself, which
 * CIP-30 and the Midnight connector API deliberately have no method for (`docs/MCP_DEV_TOOL_SPEC.md`
 * §3.2). Shaped like `./cardano-building.ts`'s runners for the same reason: everything
 * surface-specific is injected, so the body is the rule and nothing else.
 *
 * ⚠️ **A builder raises no new authority — it adds competence.** `buildCoFundedSend` produces a
 * transaction and then routes it to the one review screen, exactly as every other write does; nothing
 * here signs outside that path. What it adds is a transaction an agent could not hand-assemble: the
 * co-funded offer has to be finalised before anyone signs and the signatures placed by input index,
 * and getting that wrong fails at the node with nothing naming the cause.
 *
 * @module
 */

import {hex} from '@pnyx/crypto'
import type {LocalToolOutcome} from '@pnyx/mcp-server'
import {txFactsJson} from '@pnyx/midnight-native'
import {midnightTxEffect, readMidnightTxFactsJson} from '@pnyx/tx-review'
import {logger} from '../../logger'
import type {ParsedMidnightCoFund} from '../mcp/build-args'
import {describeBuildFailure} from '../midnight/build-failure'
import {registerMidnightDappTicket} from '../midnight/dapp-tickets'
import {runMidnight} from '../midnight/effect-boundary'
import {buildCoFundedSend} from '../midnight/multiparty/co-funded-send'
import {cofundLocks} from '../midnight/multiparty/cofund-locks'
import {addUnshieldedLock} from '../midnight/wallet/unshielded-pending-store'
import {type GrantedMidnightScope, resolveCoFundParticipants} from './midnight-cofund-participants'
import {midnightReadRefusal} from './midnight-read-refusal'
import type {BuiltByUs} from './midnight-signing'

export type {GrantedMidnightScope} from './midnight-cofund-participants'

const ORIGIN = 'midnight-building'

/** An hour, matching every other Midnight transfer this app builds. */
const TTL_SECONDS = 3600

const refuse = (message: string): LocalToolOutcome => ({ok: false, message})

/**
 * `midnight_buildCoFundedSend`: several granted wallets funding one payment, then reviewed.
 *
 * ⚠️ **It builds before it asks.** The review reads the transaction rather than the request
 * (`docs/MIDNIGHT_REVIEW_FROM_BYTES.md`), and there is no transaction to read until every contributor
 * has signed — so the vaults open, the wallets sync and the offer is signed *first*. That is not
 * silent: opening a vault is a biometric prompt per wallet, and nothing is submitted or handed back
 * until a person has approved what the bytes actually do.
 *
 * ⚠️ **Only granted scopes may contribute**, and that is the whole authority boundary: a wallet the
 * person did not put in this agent's scope list cannot be named as a source.
 */
export const runAgentMidnightCoFundedSend = async (params: {
  readonly intent: ParsedMidnightCoFund
  /** Every scope this agent was granted, so a source can be resolved to a wallet on this device. */
  readonly granted: ReadonlyMap<string, GrantedMidnightScope>
  /** The scope the call was addressed to — it must be one of the contributors. */
  readonly composerKey: string
  readonly networkId: string
  readonly origin: string
  /** Localized biometric-prompt title; the vault needs one per wallet it opens. */
  readonly biometricPrompt: string
  readonly navigateToReview: (ticketId: string) => void
  readonly answer: (outcome: LocalToolOutcome) => void
  readonly builtByUs: BuiltByUs
}): Promise<void> => {
  const {intent, granted, composerKey, answer} = params
  try {
    const resolved = resolveCoFundParticipants(intent.sources, granted, composerKey)
    if (!resolved.ok) {
      answer(refuse(resolved.message))
      return
    }
    const participants = resolved.participants

    const built = await buildCoFundedSend({
      participants,
      recipient: intent.recipient,
      tokenType: intent.tokenType,
      networkId: params.networkId,
      ttlSecs: Math.floor(Date.now() / 1000) + TTL_SECONDS,
      biometricPrompt: params.biometricPrompt,
    })
    const txHex = hex.encode(built.transaction)

    /**
     * The composer's wallet, because that is the one the review persists against.
     *
     * ⚠️ Every other contributor is named through `ourWallets` instead. A ticket carries one (group,
     * account) and Midnight's per-wallet state is keyed by it, so the composer is the only right answer
     * here — but the *review* has to be able to name all of them, or a contributor's own change would
     * read as a payment to a stranger.
     */
    const composer = granted.get(composerKey)
    if (composer === undefined) {
      answer(refuse(`the wallet for scope '${composerKey}' could not be opened on this device`))
      return
    }

    const ticketId = registerMidnightDappTicket({
      kind: 'transaction',
      origin: params.origin,
      groupId: composer.groupId,
      accountIndex: composer.accountIndex,
      walletLabel: composer.name,
      txHex,
      submitAfterApproval: intent.submit,
      ourWallets: built.contributions.map((contribution) => ({
        address: contribution.address,
        name: contribution.name,
      })),
      settle: () => {
        // Remembered like any other transaction this wallet built: the sponsor pays for whatever
        // `submitTransaction` relays, so only what we built may be relayed.
        params.builtByUs.remember(txHex)
        /**
         * Lock what each contributor is spending — **every one of them, not just the composer.**
         *
         * ⚠️ Without this a co-funded send left the other wallets offering outputs it had already
         * spent: they are not the selected wallet, nothing is listening to them, and their cached set
         * therefore does not change until something opens them. The next build selects a spent output
         * and the node refuses the whole transaction — exactly what `unshielded-pending-store` exists
         * to prevent, and this builder predated being wired into it.
         *
         * Fire-and-forget with its own reporting: the transaction is already going out, and a lock that
         * fails to persist must not turn a sent transfer into a thrown error. The lock expires with the
         * transaction's own TTL.
         */
        for (const {groupId, accountIndex, lock} of cofundLocks(
          built.contributions,
          built.identifiers,
          Math.floor(Date.now() / 1000) + TTL_SECONDS,
        )) {
          void runMidnight(addUnshieldedLock(groupId, accountIndex, lock)).catch((error: unknown) => {
            logger.warn('a co-funded contributor’s inputs could not be locked; it may offer them again', {
              origin: ORIGIN,
              groupId,
              error: String(error),
            })
          })
        }
        answer({
          ok: true,
          value: {
            transaction: txHex,
            submitted: intent.submit,
            payment: built.payment.toString(),
            tokenType: intent.tokenType,
            recipient: intent.recipient,
            contributions: built.contributions.map((contribution) => ({
              name: contribution.name,
              address: contribution.address,
              pledge: contribution.pledge.toString(),
              inputs: contribution.inputs,
            })),
          },
        })
      },
      reject: (reason) => answer(refuse(reason)),
    })
    logger.debug('built a co-funded Midnight transfer for an agent, awaiting review', {
      origin: ORIGIN,
      contributors: participants.length,
      payment: built.payment.toString(),
      bytes: built.transaction.length,
    })
    params.navigateToReview(ticketId)
  } catch (error) {
    const message = describeBuildFailure(error)
    logger.warn('an agent’s co-funded Midnight send could not be built', {origin: ORIGIN, error: message})
    answer(refuse(message))
  }
}

/**
 * `midnight_readTransaction`: explain a Midnight transaction, read from the transaction.
 *
 * The parity with `cardano_readTransaction` that Midnight lacked — an agent handed a Midnight
 * transaction could previously only describe bytes it cannot read, which is exactly the case where a
 * language model produces a confident wrong answer with nothing failing.
 *
 * ⚠️ **`understood` and `gaps` are the point, not a footnote.** A partial read produces figures that
 * are *wrong* rather than rough, so both travel with every answer and the tool's own description tells
 * the agent to read them first.
 */
export const readAgentMidnightTransaction = async (params: {
  readonly txHex: string
  /** This device's unshielded addresses, so what the wallet nets can be attributed at all. */
  readonly ourAddresses: readonly string[]
}): Promise<LocalToolOutcome> => {
  const decoded = hex.decode(params.txHex)
  if (decoded._tag === 'Left') return refuse('`transaction` is not hex')
  let json: string
  try {
    json = await txFactsJson(decoded.right)
  } catch (error) {
    // ⚠️ `warn`, not `debug`: the reader's own message is the only thing that says *why*, and at debug
    // it was invisible in a buffer this app fills with HTTP tracing.
    logger.warn('the native reader would not read an agent’s transaction', {
      origin: ORIGIN,
      error: String(error),
    })
    return refuse(midnightReadRefusal(error))
  }
  const {facts, unreadable} = readMidnightTxFactsJson(json)
  if (unreadable !== null) {
    // The native reader and the parser disagreeing about a shape — a drift with nothing else to notice
    // it. The agent still gets `understood: false` and the gaps; this is what makes it diagnosable.
    logger.error('the native transaction reader’s answer could not be read', {origin: ORIGIN, reason: unreadable})
  }
  // No `shielded` half: opening our own shielded outputs needs the Zswap key, which this read does not
  // hold. A shielded offer is therefore reported as a gap rather than decrypted — the honest answer,
  // and the one that keeps the totals from including a figure nobody could see.
  const effect = midnightTxEffect({facts, ourAddresses: params.ourAddresses})
  logger.debug('an agent read a Midnight transaction', {
    origin: ORIGIN,
    understood: effect.understood,
    intents: facts.intents.length,
    gaps: effect.gaps.length,
  })
  return {
    ok: true,
    value: {
      understood: effect.understood,
      gaps: effect.gaps,
      networkId: facts.networkId,
      segments: facts.intents.map((one) => ({
        segment: one.segment,
        expiresAtSecs: one.ttlSecs,
        guaranteed: describeSide(one.guaranteed),
        fallible: describeSide(one.fallible),
        calls: one.calls,
        deploys: one.deploys,
        unnamedActions: one.otherActions,
      })),
      // A count, never an amount — see the tool description and `MidnightTxFacts.shieldedOutputs`.
      shieldedOutputs: facts.shieldedOutputs,
      hasShielded: facts.hasShielded,
      thisWalletNets: [...effect.delta.entries()].map(([tokenType, net]) => ({tokenType, amount: net.toString()})),
      toOthers: effect.toOthers.map(describeUtxo),
    },
  }
}

/** Atomic amounts as decimal strings, for the reason every other agent-facing figure is one. */
const describeUtxo = (utxo: {readonly colour: string; readonly value: bigint; readonly owner: string}) => ({
  tokenType: utxo.colour,
  amount: utxo.value.toString(),
  owner: utxo.owner,
})

const describeSide = (side: {
  readonly inputs: readonly {readonly colour: string; readonly value: bigint; readonly owner: string}[]
  readonly outputs: readonly {readonly colour: string; readonly value: bigint; readonly owner: string}[]
}) => ({inputs: side.inputs.map(describeUtxo), outputs: side.outputs.map(describeUtxo)})
