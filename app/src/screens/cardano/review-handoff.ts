/**
 * In-memory handoff for the review-tx screen. The IR, the signing request, and
 * the composed signing layer are not router-serializable, so producers (the
 * send flow, the dApp connector) register a ticket and navigate with its id;
 * the review screen claims it by id and reports the outcome back through the
 * producer's callbacks.
 *
 * Tickets are single-consumer and evicted on settle/cancel, so a backgrounded
 * or duplicate mount can't cross-deliver a result to the wrong producer.
 *
 * @module
 */

import type {SigningRequest, SigningServiceTag, SigningSuccess} from '@pnyx/signing-service'
import type {ReviewedTransaction, TransactionWarning} from '@pnyx/tx-review'
import type {Layer} from 'effect'
import type {DecodedSignData} from '../../components/DappBrowser/sign-data-decode'
import type {TranslationKey} from '../../i18n/types'
import type {SignatureStatus} from '../../services/cardano/cosign/types'
import type {SigningAuditContext} from '../../services/signing-audit'

/**
 * One thing in a ceremony: what the user sees and what gets signed. The pair is
 * inseparable — a review without its request could be confirmed into nothing — so
 * the sequence is typed as legs rather than parallel arrays.
 *
 * Two subjects, because a signature is not always over a transaction. `kind` is
 * **optional on the transaction variant** so that every existing producer stays
 * valid unchanged; a message leg must say so explicitly.
 */
export type ReviewLeg = ReviewTransactionLeg | ReviewMessageLeg

/** A transaction to review and sign. The default subject. */
export type ReviewTransactionLeg = {
  readonly kind?: 'transaction'
  readonly reviewed: ReviewedTransaction
  readonly request: SigningRequest
}

/**
 * An arbitrary payload to sign (CIP-8 / CIP-30 `signData`) — a login challenge, a
 * plain message, or bytes that decode to neither.
 *
 * It carries the **decoded** form, never a summary written by the requester:
 * `payloadHex` is attacker-controlled, so the screen renders what
 * `decodeSignDataPayload` could actually prove about the bytes.
 *
 * Deliberately *not* a `ReviewedTransaction`: a signed message moves no value, so
 * it must not borrow transaction chrome (fee, balance impact, party tiers) that
 * would imply otherwise.
 */
export type ReviewMessageLeg = {
  readonly kind: 'message'
  readonly message: DecodedSignData
  /** Raw address bytes whose key signs — shown so the user knows *which* identity is asserting. */
  readonly addressHex: string
  /** Requesting origin, or `null` when there is none. Always rendered as unverified. */
  readonly origin: string | null
  /**
   * Who asked for this signature.
   *
   * ⚠️ **The producer's word, never the requester's.** `origin` is attacker-controlled whenever it
   * is non-null, so a dApp could otherwise present itself as the app the user is holding. This is
   * set by the code path that registered the ceremony and by nothing else — which is why it is
   * required rather than defaulted, exactly like `audit`.
   *
   * It exists because `origin: null` had come to mean two different things: an in-app action with
   * no site to name, and an external request that named none. Both rendered "Something is asking
   * you to sign this message. Its source is unverified" — true of the second, and of the first a
   * small lie told by the app about itself.
   */
  readonly requestedBy: 'app' | 'external'
  readonly request: SigningRequest
}

/** Narrowing helper, so call sites read as intent rather than as a discriminant check. */
export const isMessageLeg = (leg: ReviewLeg): leg is ReviewMessageLeg => leg.kind === 'message'

export type ReviewTicket = {
  /**
   * The transactions to consent to, in submission order. Single-element for
   * every producer except the Send compose queue, where a later leg may spend
   * an earlier one's change.
   */
  readonly legs: readonly ReviewLeg[]
  readonly groupId: string
  /**
   * What this ceremony is for, and who asked for it — the signing-audit entry's
   * only caller-supplied part (`docs/SIGNING_AUDIT.md`).
   *
   * Required, because the producer is the only party that knows either value and
   * a signature nobody can account for is exactly what the log exists to surface.
   * `purpose` is a closed union so a dApp cannot author the label; `origin` is
   * attacker-controlled whenever non-null and is stored verbatim, never resolved.
   */
  readonly audit: SigningAuditContext
  /**
   * `null` when the producing wallet cannot sign at all (watch-only): the
   * transaction is still built and fully reviewable, and the screen disables
   * confirmation rather than offering a button that must fail.
   * Pair it with {@link cannotSignReasonKey}.
   */
  readonly signingLayer: Layer.Layer<SigningServiceTag> | null
  /** i18n key explaining why signing is unavailable; required when `signingLayer` is null. */
  readonly cannotSignReasonKey?: string
  /**
   * Screen title override — else derived from the IR.
   *
   * ⚠️ Typed as a `TranslationKey`, not a string: this was set by nine producers and read by
   * nothing, and the one key that would have exposed that (`cardanoSend.programmableTitle`) had
   * never been added to the catalogue. A wrong key is a compile error now, not a raw path on screen.
   */
  readonly titleKey?: TranslationKey
  /**
   * Names this ceremony in the persisted continuation, so the pending inbox can say what a
   * partially-completed flow *was* instead of "Multi-step transaction".
   */
  readonly continuationContext?: string
  /**
   * i18n key for what the producer needs the user to understand about *this*
   * ceremony — why there are two legs, what the second one is for. It renders on
   * the review screen because that is what it describes; a toast gets one line
   * and then disappears while the user is still reading the transactions.
   */
  readonly noticeKey?: string
  /**
   * Warnings that are definitional for what this producer built, so they are not
   * shown as alarms. An allowlist per producer, never global: a dApp-supplied
   * transaction declares nothing and keeps every warning, and anything the
   * producer did *not* expect still surfaces.
   */
  readonly expectedWarnings?: readonly TransactionWarning[]
  /** Multisig/multiparty quorum status — renders the Signatures quorum panel. */
  readonly signatureStatus?: SignatureStatus
  /**
   * Whose signature this ceremony produces, when that is a choice the user made.
   *
   * A shared wallet's transaction is signed by one of its co-signers, and which
   * one is not visible in the bytes. Naming it on the confirm button is the last
   * chance to notice it is the wrong person before the witness exists.
   */
  readonly signerName?: string
  /**
   * Where to go once signing succeeds.
   *
   * Omitted means **the wallet home**, because that is right for almost every producer: the
   * transaction is submitted, and home is where its pending row appears. Returning into the flow
   * that produced it invites the user to do the same thing twice — a completed send funnel is
   * several screens deep, and `back()` walked them straight back into it.
   *
   * `null` means "stay where you were" (`back()`), and is for producers whose flow is **not over
   * when the signature lands**: an air-gap screen that must show the signed payload to be scanned,
   * a co-sign or gather step that continues, a dApp request that belongs back in the dApp's
   * context. Those must say so — leaving it out would strand the very thing the user came for.
   */
  readonly doneHref?: string | null
  /**
   * Every leg that landed, in submission order. Shorter than `legs` when a
   * ceremony failed part-way — those transactions are still real, so the
   * producer is told about them before `onError`.
   */
  readonly onSettled: (results: readonly SigningSuccess[]) => void
  /** Called if signing fails after confirmation (the screen shows the error too). */
  readonly onError: (error: unknown) => void
  /** Called if the user dismisses without confirming. */
  readonly onCancel: () => void
}

const tickets = new Map<string, ReviewTicket>()
let counter = 0

/** Register a ticket; returns the id to pass as the `ticket` route param. */
export const registerReviewTicket = (ticket: ReviewTicket): string => {
  counter += 1
  const id = `rvw_${counter}`
  tickets.set(id, ticket)
  return id
}

/** Read a ticket without consuming it (the screen reads on mount to render). */
export const peekReviewTicket = (id: string): ReviewTicket | undefined => tickets.get(id)

/** Consume + remove a ticket (call once the outcome is delivered / cancelled). */
export const consumeReviewTicket = (id: string): ReviewTicket | undefined => {
  const ticket = tickets.get(id)
  tickets.delete(id)
  return ticket
}

/** Drop a ticket without delivering — used when a producer aborts. */
export const evictReviewTicket = (id: string): void => {
  tickets.delete(id)
}

/** Where a successful ceremony lands when the producer stays quiet. */
export const DEFAULT_DONE_HREF = '/wallets'

/**
 * The route to unwind to once signing succeeds, or `null` to stay put.
 *
 * A rule rather than a `??` because the two absences mean opposite things: an omitted `doneHref`
 * is a producer with no opinion, which should land on the wallet home, while an explicit `null` is
 * a producer that must not leave — an air-gap screen holding a signature to be scanned, a co-sign
 * step mid-flow. Collapsing them would strand the first kind or annoy the second.
 */
export const doneDestination = (doneHref: string | null | undefined): string | null =>
  doneHref === undefined ? DEFAULT_DONE_HREF : doneHref
