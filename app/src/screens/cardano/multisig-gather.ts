/**
 * What a shared wallet's signature is *for*.
 *
 * The signing service produces the partial witness (`applyAuthorityToRequest`
 * forces every script-wallet request to a partial, sign-only pass). This is the
 * other half of that split: turning the witness into a `TxEnvelope`, tracking
 * it, and handing it to the co-sign rail — which already reviews, gathers and
 * submits or re-exports.
 *
 * Wrapping a ticket rather than teaching each flow means send, stake and the
 * rest keep their own `onSettled` for the ordinary case and gain the gather for
 * free.
 *
 * @module
 */

import type {Decode} from '@evolution-sdk/review/Decode'
import type {CborError} from '@evolution-sdk/review/Errors'
import * as Inspect from '@evolution-sdk/review/Inspect'
import type {CoreError} from '@pnyx/cardano-core/Op'
import {type CardanoChainId, cardanoChainId} from '@pnyx/config'
import type {SigningSuccess} from '@pnyx/signing-service'
import {bodyNamesStakeScript} from '@pnyx/tx-review'
import {Effect} from 'effect'
import {logger} from '../../logger'
import type {SpendAuthority} from '../../services/cardano/account'
import {addSignature, envelopeWitnessesFrom, platformPersistCosign, stableCosignId} from '../../services/cardano/cosign'
import {constructEnvelope} from '../../services/cardano/cosign/envelope'
import type {EnvelopeSigner, ScriptRole, TxEnvelope} from '../../services/cardano/cosign/types'
import {paymentKeyHashes, stakeKeyHashes} from '../../services/cardano/multisig/derive'
import {signersFor} from '../../services/cardano/multisig/spend'
import type {SharedWallet} from '../../services/cardano/multisig/types'
import {STAKE_INDEX} from '../../services/cardano/multisig/types'
import type {CardanoRail} from '../../services/cardano/rail'
import type {ReviewTicket} from './review-handoff'

export type GatherContext = {
  readonly authority: Extract<SpendAuthority, {kind: 'script'}>
  readonly chainId: CardanoChainId
  /** The wallet group the pending envelope is filed under — the shared wallet's own id. */
  readonly groupId: string
  /** Display name for the envelope's origin, so a co-signer sees whose wallet it is. */
  readonly createdBy: string
  readonly accountIndex: number
  /**
   * The payment indexes this spend draws on, parallel to the authority's scripts.
   * One entry is the ordinary case; more when the wallet's funds sit at several.
   */
  readonly keyIndexes: readonly number[]
  /**
   * The scripts this transaction must carry, and what each guards — payment
   * scripts for the indexes it spends at, plus the delegation script when it also
   * delegates, deregisters or withdraws. Resolved once here rather than read off
   * the authority at envelope time, because whether the stake script belongs is a
   * property of the *transaction*, not of the wallet.
   */
  readonly nativeScriptHexes: readonly string[]
  readonly scriptRoles: readonly ScriptRole[]
  /**
   * Roster rows, so the quorum panel can name who is still outstanding — one per
   * (co-signer, script), because a co-signer owes a witness at every index the
   * spend touches and one more for the delegation when there is one.
   */
  readonly signers: readonly EnvelopeSigner[]
  readonly createdAt: string
  /**
   * The body being signed.
   *
   * Taken from the request rather than the result: a sign-only pass returns a
   * witness set and nothing else, and reconstructing the body from the witness
   * is not possible.
   */
  readonly bodyHex: string
}

/**
 * The gather context for a shared wallet's spend, or `null` for a key wallet.
 *
 * `null` rather than a thrown error on the ordinary path, so a producer wires
 * this in unconditionally and never branches on what kind of wallet it holds —
 * `withGather` returns the ticket by identity when it gets one.
 *
 * The roster's key hashes are re-derived at the spending index rather than read
 * positionally off `authority.signerKeyHashes`. The two agree today, but an
 * envelope whose signer rows are bound to co-signers by array position is one
 * roster reorder away from naming the wrong person as having signed.
 */
export const buildGatherContext = (params: {
  /** Only what it reads: the authority to gather for and the network. */
  readonly rail: Pick<CardanoRail, 'account' | 'config'>
  readonly shared: {readonly wallet: SharedWallet; readonly keyIndex: number} | null
  readonly bodyHex: string
  readonly createdAt: string
}): Effect.Effect<GatherContext | null, CoreError | CborError, Decode> =>
  Effect.gen(function* () {
    const shared = params.shared
    const authority = params.rail.account.authority
    if (shared === null || authority.kind !== 'script') return null
    // The authority's indexes, not the selected one alone: a spend may draw on
    // several, and each owes its own signatures. Order is the authority's, which is
    // also the order its scripts go into the envelope.
    const keyIndexes = authority.indexes.map((i) => i.keyIndex)
    const rows = yield* Effect.forEach(keyIndexes, (keyIndex, scriptIndex) =>
      paymentKeyHashes(shared.wallet.coSigners, keyIndex).pipe(
        Effect.map((byTag) => signersFor(shared.wallet, byTag, scriptIndex)),
      ),
    )

    // Read from the body, not declared by the caller. A flow that had to announce
    // "this one delegates" is a flow that can forget to, and the cost of
    // forgetting is an envelope missing a script the signature already covered —
    // which assembles into a transaction the ledger rejects, after the whole
    // quorum has signed.
    const {body} = yield* Inspect.txBody(params.bodyHex)
    const delegates = bodyNamesStakeScript(body, authority.stake.scriptHashHex)
    const stakeRows = delegates
      ? signersFor(shared.wallet, yield* stakeKeyHashes(shared.wallet.coSigners), keyIndexes.length)
      : []

    return {
      authority,
      // Payment scripts first, so a legacy reader's `scriptIndex` still points at
      // the same payment script it always did.
      nativeScriptHexes: [
        ...authority.indexes.map((i) => i.nativeScriptHex),
        ...(delegates ? [authority.stake.nativeScriptHex] : []),
      ],
      scriptRoles: [...keyIndexes.map(() => 'payment' as const), ...(delegates ? ['stake' as const] : [])],
      // The network-specific id, not the device layer's chain *family* — the
      // envelope's networkId and protocol magic are read back off it, and a
      // preprod transaction labelled mainnet cannot be assembled correctly.
      chainId: cardanoChainId(params.rail.config.network),
      groupId: shared.wallet.id,
      createdBy: shared.wallet.name,
      accountIndex: shared.wallet.accountIndex,
      // The stake entry carries index 0, because CIP-1854 pins stake keys there.
      // Its role, not its value, is what tells a co-signer to derive at role 2.
      keyIndexes: [...keyIndexes, ...(delegates ? [STAKE_INDEX] : [])],
      signers: [...rows.flat(), ...stakeRows],
      createdAt: params.createdAt,
      bodyHex: params.bodyHex,
    }
  })

/**
 * Build the envelope for a freshly signed script transaction.
 *
 * The witness set from the ceremony is merged in rather than assumed to be the
 * only one, because a resumed envelope may already carry others.
 */
export const envelopeFromSignature = (
  ctx: GatherContext,
  bodyHex: string,
  witnessSetHex: string,
  existing?: TxEnvelope,
): Effect.Effect<TxEnvelope, never, never> =>
  Effect.gen(function* () {
    const base =
      existing ??
      constructEnvelope({
        kind: 'multisig',
        bodyHex,
        nativeScriptHexes: ctx.nativeScriptHexes,
        scriptRoles: ctx.scriptRoles,
        chainId: ctx.chainId,
        createdBy: ctx.createdBy,
        createdAt: ctx.createdAt,
        accountIndex: ctx.accountIndex,
        keyIndexes: ctx.keyIndexes,
        signers: ctx.signers,
      })
    const witnesses = yield* envelopeWitnessesFrom(witnessSetHex).pipe(
      // A witness set we cannot decode is a signature we cannot account for.
      // Reported, not silently dropped: the envelope would otherwise look one
      // signature further along than it is.
      Effect.catchAll((e) => {
        logger.warn('Co-sign witness decode failed', {origin: 'MultisigGather', message: e.message})
        return Effect.succeed([])
      }),
    )
    return witnesses.reduce<TxEnvelope>((env, w) => addSignature(env, w), base)
  })

/**
 * Wrap a ticket so a script wallet's signature becomes a tracked envelope and
 * routes into the co-sign rail instead of completing.
 *
 * A key wallet's ticket is returned untouched, by identity.
 */
export const withGather = (
  ticket: ReviewTicket,
  ctx: GatherContext | null,
  navigateToGather: (pendingId: string) => void,
): ReviewTicket => {
  if (ctx === null) return ticket
  return {
    ...ticket,
    // The panel is the honest description of what the user is confirming: not
    // "this will be submitted" but "this needs N signatures, and yours is one".
    signatureStatus: ticket.signatureStatus ?? {
      kind: 'multisig',
      // Summed across every script this transaction carries: two indexes of a
      // 2-of-3 owe four signatures, and a delegation owes its own quorum on top.
      // A panel saying "2" would have the user expecting to submit while half the
      // inputs — or the certificate — are still unauthorised.
      required:
        ctx.authority.indexes.reduce((sum, i) => sum + i.requiredSigners, 0) +
        (ctx.scriptRoles.includes('stake') ? ctx.authority.stake.requiredSigners : 0),
      total: ctx.signers.length,
      signed: ctx.signers.filter((s) => s.signed).length,
      meetsQuorum: false,
      signers: ctx.signers,
    },
    // The flow is not finished when the signature lands, it moves to gathering. Sending the user
    // to the wallet home would read as done.
    doneHref: null,
    onSettled: (results: readonly SigningSuccess[]) => {
      const result = results.length === 1 ? results[0] : undefined
      if (result?._tag !== 'TxSignedOnly') {
        // Every script-wallet request is forced sign-only, so anything else
        // means the rewrite did not run — worth saying rather than guessing.
        logger.warn('Script wallet ceremony returned an unexpected result', {
          origin: 'MultisigGather',
          tag: result?._tag ?? 'none',
        })
        ticket.onSettled(results)
        return
      }
      void Effect.runPromise(envelopeFromSignature(ctx, ctx.bodyHex, result.witnessSetHex))
        .then(async (envelope) => {
          await Effect.runPromise(Effect.ignore(platformPersistCosign(ctx.groupId, envelope)))
          navigateToGather(stableCosignId(envelope))
        })
        .catch((e: unknown) => {
          logger.warn('Gather handoff failed', {origin: 'MultisigGather', message: String(e)})
          ticket.onError(e)
        })
    },
  }
}
