/**
 * In-memory handoff between a dApp request and the review screen that approves it.
 *
 * The same shape as the Cardano `review-handoff`, and for the same reason: the callbacks that answer a
 * page are not router-serializable, so the producer registers a ticket and navigates with its id. Kept
 * separate from that module rather than widening it — its legs are typed against `ReviewedTransaction`,
 * which is Cardano's IR, and a Midnight request is not one.
 *
 * **One mechanism, three requests.** `makeTransfer`, `balanceUnsealedTransaction` and a built
 * transaction are reviewed on different screens, because a transfer has a recipient, a funding does
 * not, and a built transaction has no *request* to render at all — only bytes. A single screen covering
 * them would have to render fields that cannot exist for the others. What they share is exactly this:
 * an id, a promise waiting on the other side of it, and the rule below.
 *
 * ⚠️ **A ticket must always be settled.** A page awaiting either method has a promise open; a screen
 * that is dismissed without answering leaves the dApp hanging for ever with nothing on screen to
 * explain it. {@link rejectMidnightDappTicket} is what a cancel or an unmount calls, and it is safe to
 * call twice — the first settle evicts the ticket.
 *
 * @module
 */

import type {MidnightErrorCode} from '@pnyx/dapp-connector'

import {logger} from '../../logger'
import type {MidnightTransferRail} from './build-transfer'

const ORIGIN = 'midnight-dapp-tickets'

/** What every ticket carries: who asked, which wallet, and the two ways to answer them. */
type TicketBase = {
  /** The requesting page, shown to the user. Always rendered as unverified. */
  readonly origin: string
  /**
   * The wallet and account this request is for.
   *
   * ⚠️ **Carried, not taken from the selection.** An agent may be granted several wallets, so the
   * request names one — and a screen that read `selectedWalletGroup` instead would build, sign and
   * persist against whichever wallet the app happened to be showing. Midnight's per-wallet state is
   * keyed by (group, account), so getting this wrong writes a shielded-coin or DUST state under the
   * wrong wallet: silent, and close to unrecoverable.
   */
  readonly groupId: string
  readonly accountIndex: number
  /** How to name that wallet on screen, since it may not be the one the app is showing. */
  readonly walletLabel: string
  /** Answer the page with the transaction, hex-encoded. */
  readonly settle: (txHex: string) => void
  /**
   * Answer the page with a refusal. `reason` is shown to the dApp, not to the user.
   *
   * ⚠️ `apiCode` defaults to `Rejected`, which means **the user declined** — right for a cancel, and
   * wrong for everything else. A wallet that cannot cover the amount was telling the page its owner had
   * refused; the connector spec has `InsufficientFunds` for exactly that and it had no producer.
   */
  readonly reject: (reason: string, apiCode?: MidnightErrorCode) => void
}

/** A `makeTransfer`: this wallet composes the whole transaction. */
export type MidnightTransferTicket = TicketBase & {
  readonly kind: 'transfer'
  /**
   * Submit after approval instead of handing the bytes back.
   *
   * A page submits for itself, so it wants the bytes; an agent has no rail of its own and wants the
   * send. ⚠️ When true the review takes the **same** submit path the user's own send takes, fee
   * decision included — wiring it straight to the sponsored submit would make an agent's send always
   * sponsored while the user's own could pay its own fee.
   */
  readonly submitAfterApproval: boolean
  readonly rail: MidnightTransferRail
  readonly recipient: string
  readonly tokenType: string
  readonly amount: bigint
}

/**
 * A `balanceUnsealedTransaction`: the dApp composed the transaction and this wallet covers what it owes.
 *
 * Only the hex is carried. What it owes is the ledger's statement, read from the bytes by the screen —
 * carrying a figure through here would put a second opinion beside the authoritative one.
 */
export type MidnightFundingTicket = TicketBase & {
  readonly kind: 'funding'
  readonly txHex: string
}

/**
 * A transaction that **already exists**, reviewed from its own bytes.
 *
 * The third kind, and the one the other two are not: those carry an *intent* the screen builds after
 * approval, so what a person reads is the request restated. This carries the built transaction, and the
 * review derives every figure from it — `docs/MIDNIGHT_REVIEW_FROM_BYTES.md`.
 *
 * ⚠️ **It is the approval boundary for co-funding.** A co-funded transaction is signed by several
 * wallets before it reaches a screen, and `submitTransaction` deliberately raises no review of its own
 * ("what is being authorised was authorised when it was built"). Without this ticket a builder would
 * move several wallets' funds with nobody having seen it — which is why
 * `midnight_buildCoFundedSend` was not landed until this existed.
 *
 * ⚠️ **Nothing here describes the transaction.** There is no amount, no recipient and no rail, on
 * purpose: every one of those would be a claim the review could show back to the person as though the
 * wallet had checked it. The only thing carried beside the bytes is who this device's wallets *are*,
 * which is the one fact the bytes cannot state.
 */
export type MidnightTransactionTicket = TicketBase & {
  readonly kind: 'transaction'
  /** The built transaction, hex. Proven and unbound — the sponsor funds the fee and submits it. */
  readonly txHex: string
  /**
   * Submit after approval rather than handing the bytes back.
   *
   * Same rule as {@link MidnightTransferTicket.submitAfterApproval}: a page submits for itself, an
   * agent has no rail of its own.
   */
  readonly submitAfterApproval: boolean
  /**
   * The wallets on this device that may appear in it, by unshielded address, and how to name each.
   *
   * ⚠️ **This is what makes "whose money is whose" answerable, and it must be complete.** An address of
   * ours that is missing reads as a stranger's, so a contributor's own change would be reported as a
   * payment out; and with none of them the review reports itself as not understood rather than
   * attributing everything to strangers.
   */
  readonly ourWallets: readonly {readonly address: string; readonly name: string}[]
}

export type MidnightDappTicket = MidnightTransferTicket | MidnightFundingTicket | MidnightTransactionTicket

const tickets = new Map<string, MidnightDappTicket>()
let counter = 0

/** Register a request and get the id to navigate with. */
export const registerMidnightDappTicket = (ticket: MidnightDappTicket): string => {
  counter += 1
  const id = `mnt-${counter.toString(36)}`
  tickets.set(id, ticket)
  logger.debug('a dApp request is waiting for review', {origin: ORIGIN, id, dapp: ticket.origin, kind: ticket.kind})
  return id
}

/**
 * Read a ticket without consuming it.
 *
 * The screen needs it on every render (it renders what the ticket says), so claiming on read would
 * make the second render an empty screen.
 */
export const readMidnightDappTicket = (id: string | undefined): MidnightDappTicket | undefined =>
  id === undefined ? undefined : tickets.get(id)

/**
 * Read a ticket only if it is the kind this screen reviews.
 *
 * A funding id opened on the transfer screen, or the reverse, is a mismatch worth logging rather than
 * rendering: both screens key off the same `dapp` param, so a wrong link would otherwise show a review
 * built from missing fields.
 */
export const readMidnightDappTicketOfKind = <K extends MidnightDappTicket['kind']>(
  id: string | undefined,
  kind: K,
): Extract<MidnightDappTicket, {kind: K}> | undefined => {
  const ticket = readMidnightDappTicket(id)
  if (ticket === undefined) return undefined
  if (ticket.kind !== kind) {
    logger.warn('a dApp ticket was opened on the wrong review screen', {
      origin: ORIGIN,
      id,
      expected: kind,
      found: ticket.kind,
    })
    return undefined
  }
  return ticket as Extract<MidnightDappTicket, {kind: K}>
}

/** Answer the page and evict. A second call is a no-op, so a settle then an unmount is safe. */
export const settleMidnightDappTicket = (id: string, txHex: string): void => {
  const ticket = tickets.get(id)
  if (ticket === undefined) return
  tickets.delete(id)
  ticket.settle(txHex)
}

/** Refuse the page and evict — the cancel and unmount path. A second call is a no-op. */
export const rejectMidnightDappTicket = (id: string, reason: string, apiCode?: MidnightErrorCode): void => {
  const ticket = tickets.get(id)
  if (ticket === undefined) return
  tickets.delete(id)
  logger.debug('a dApp request was refused', {origin: ORIGIN, id, dapp: ticket.origin, reason, apiCode})
  ticket.reject(reason, apiCode)
}
