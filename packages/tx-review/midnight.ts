/**
 * Midnight's transaction view model — what a review and a past-transaction detail both render.
 *
 * Deliberately **not** folded into {@link ReviewedTransaction}. That IR is a six-tab surface over
 * UTxO graphs, certificates, scripts and signature ceremonies; a Midnight transfer has none of those,
 * so reusing it would mean four empty tabs and a `chain` discriminant that has to be checked at every
 * field. The two chains share the *primitives* — amount formatting, warning lists, the sticky CTA —
 * not the shape of a transaction.
 *
 * One view model with two constructors, mirroring Cardano's single `TxReview` in `confirm` and
 * `detail` modes:
 *
 * - {@link reviewMidnightTransfer} — a transfer about to be signed. Knows its inputs, its change and
 *   its TTL; knows no hash, because it does not have one yet.
 * - {@link viewMidnightActivity} — a transaction already on chain. Knows its hash, block and net
 *   effect; knows nothing of the inputs that were selected to build it.
 *
 * A union rather than a lowest common denominator: a draft with a nullable hash and a settled
 * transaction with a nullable change output would let a screen render a field that cannot exist, and
 * the type would stop saying which case it is looking at.
 *
 * @module
 */

import type {MidnightEffectGap, MidnightTxEffect} from './midnight-effect.js'
import type {MidnightTxFacts} from './midnight-facts.js'

/** Which Midnight rail the transfer moves value on. An address says which — nothing is configured. */
export type MidnightRail = 'unshielded' | 'shielded'

/**
 * Facts worth surfacing before someone signs.
 *
 * Only real hazards. "The sponsor pays the fee" and "this needs proving first" are properties of the
 * rail, carried as fields below, because a screen that renders normal operation as a warning teaches
 * people to skip warnings.
 */
export type MidnightTransferWarning =
  /**
   * The recipient's address names a different Midnight network than the wallet is on. Well-formed,
   * and unspendable there — the transaction would be rejected, or worse, accepted on a chain the
   * recipient is not watching.
   */
  | 'recipient-on-another-network'
  /**
   * Nothing is left on this rail afterwards — worth saying, because fees here are not ours to keep.
   *
   * Raised only against a balance that is actually known; see `MidnightTransferDraft.balance`.
   */
  | 'spends-entire-balance'

/**
 * Facts worth stating that are not hazards.
 *
 * Separate from {@link MidnightTransferWarning} because severity is the model's to decide, not the
 * screen's: a note rendered in the warning colour is a warning, whatever the field is called, and
 * warnings that fire on ordinary use are how people learn to skip them.
 */
export type MidnightTransferNote =
  /**
   * The recipient is one of our own addresses.
   *
   * Entirely legitimate — moving between your own wallets, or consolidating a rail — and rarely a
   * mistake worth an alarm. Worth *saying*, because it is easy to paste the wrong one of your own.
   */
  'sending-to-self'

/** How the fee is paid. Midnight fees are DUST — either the sponsor's or, now, the sender's own. */
export type MidnightFeePayer =
  /** The service balances the transaction with its own DUST; the sender pays nothing. */
  | {readonly by: 'sponsor'}
  /**
   * The sender's own DUST, from a synced dust state.
   *
   * ⚠️ `dust` is `null` when the amount is **not yet known**, which is the normal case before the
   * transaction is built: the dust action that pays the fee changes the size that sets it, so the
   * figure exists only afterwards. It is nullable rather than defaulted to `0n` because a review
   * showing a fee of zero would be stating a price nobody has computed.
   */
  | {readonly by: 'self'; readonly dust: bigint | null}

export type MidnightTransferDraft = {
  readonly rail: MidnightRail
  /** The Midnight network the wallet is reading. */
  readonly network: string
  /** 32-byte token type, hex. NIGHT is all zeroes. */
  readonly tokenType: string
  readonly recipient: string
  /** The network the recipient's own address names, from its HRP. */
  readonly recipientNetwork: string
  readonly amount: bigint
  /** Our addresses, so a self-send is recognised rather than reported as an ordinary payment. */
  readonly ourAddresses: readonly string[]
  /** Atomic total the selected inputs hold. */
  readonly selected: bigint
  readonly inputCount: number
  /**
   * Everything this rail holds of `tokenType`, to tell a full spend from a partial one.
   *
   * `null` when the rail cannot report it — the shielded rail's holdings come from a coin core that
   * may not have synced. Unknown is not "all of it": a caller that passed the amount itself to fill
   * this field made `spends-entire-balance` fire on every send, which is how a warning stops meaning
   * anything.
   */
  readonly balance: bigint | null
  readonly fee: MidnightFeePayer
  /** Absolute expiry, unix seconds. */
  readonly ttlSecs: number
}

export type MidnightConfirmView = {
  readonly mode: 'confirm'
  readonly rail: MidnightRail
  readonly network: string
  readonly tokenType: string
  readonly recipient: string
  readonly amount: bigint
  /** What returns to the sender. `0n` for an exact spend — an absent output, not a missing figure. */
  readonly change: bigint
  readonly inputCount: number
  readonly fee: MidnightFeePayer
  readonly ttlSecs: number
  /** True when the rail has to prove before it can submit — the shielded one does, in ~40 s. */
  readonly needsProving: boolean
  readonly warnings: readonly MidnightTransferWarning[]
  /** Neutral facts, rendered informationally — never in the warning colour. */
  readonly notes: readonly MidnightTransferNote[]
}

/** A transaction already on chain, as the indexer reported it. */
export type MidnightSettledTransaction = {
  readonly hash: string
  readonly timestamp?: string
  readonly blockHeight?: number
  readonly direction: 'sent' | 'received' | 'self'
  /** Signed atomic totals per token type: positive received, negative spent. */
  readonly netByToken: ReadonlyMap<string, bigint>
  readonly fee?: bigint
  readonly counterparties: readonly string[]
  /**
   * How many of the **holder's own** unshielded outputs this spent, and how many came back.
   *
   * Not the transaction's totals: an address-scoped feed only reports the holder's side, so a
   * payment's output to its recipient is not counted here. Worth stating on this rail because the
   * input count is consequential — it decides whether the ledger accepts the transaction at all, and
   * spending many small outputs reshapes what the wallet can send next.
   */
  readonly ourSpentCount: number
  readonly ourCreatedCount: number
}

export type MidnightDetailView = {
  readonly mode: 'detail'
  readonly rail: MidnightRail
  readonly network: string
  readonly hash: string
  readonly timestamp?: string
  readonly blockHeight?: number
  readonly direction: 'sent' | 'received' | 'self'
  readonly netByToken: ReadonlyMap<string, bigint>
  /**
   * The fee the chain recorded, when it stated one. `undefined` is "the indexer did not say", which
   * is not the same as free — and on a sponsored send the fee was never the sender's anyway.
   */
  readonly fee?: bigint
  readonly counterparties: readonly string[]
  /** The holder's own outputs spent and returned — see {@link MidnightSettledTransaction.ourSpentCount}. */
  readonly ourSpentCount: number
  readonly ourCreatedCount: number
  /** Absent when the transaction has no block yet: it is in the mempool, not lost. */
  readonly confirmed: boolean
}

export type MidnightTxView = MidnightConfirmView | MidnightDetailView

/**
 * Build the review for a transfer about to be signed.
 *
 * Change is derived here rather than taken from the caller, because it is the one figure a send
 * screen must not get wrong: an unshielded offer conserves value per token type, so whatever is not
 * sent comes back, and a screen that displayed a change it did not compute could disagree with the
 * transaction being signed.
 */
export const reviewMidnightTransfer = (draft: MidnightTransferDraft): MidnightConfirmView => {
  const warnings: MidnightTransferWarning[] = []
  if (draft.recipientNetwork !== draft.network) warnings.push('recipient-on-another-network')
  if (draft.balance !== null && draft.amount >= draft.balance) warnings.push('spends-entire-balance')

  const notes: MidnightTransferNote[] = []
  if (draft.ourAddresses.includes(draft.recipient)) notes.push('sending-to-self')

  const change = draft.selected > draft.amount ? draft.selected - draft.amount : 0n

  return {
    mode: 'confirm',
    rail: draft.rail,
    network: draft.network,
    tokenType: draft.tokenType,
    recipient: draft.recipient,
    amount: draft.amount,
    change,
    inputCount: draft.inputCount,
    fee: draft.fee,
    ttlSecs: draft.ttlSecs,
    needsProving: draft.rail === 'shielded',
    warnings,
    notes,
  }
}

/**
 * What a dApp's transaction owes, per token — the ledger's own figure.
 *
 * `owed` is a magnitude: the sign is resolved before it gets here, because a surplus is legal and only
 * a deficit is fundable. `segment` travels because it is what makes a deficit fundable at all (a
 * deficit is cancelled inside its own segment's intent) and because naming it is how a refusal becomes
 * actionable for the dApp.
 */
export type MidnightFundingLeg = {
  readonly tokenType: string
  readonly segment: number
  readonly owed: bigint
  /**
   * Everything this wallet holds of `tokenType` on the unshielded rail, or `null` where it cannot say.
   *
   * Same rule as {@link MidnightTransferDraft.balance}: unknown is not "enough" and not "none". A
   * caller that passed `owed` here would make `funds-entire-balance` fire on every funding.
   */
  readonly balance: bigint | null
}

/**
 * Hazards specific to funding a transaction somebody else composed.
 *
 * The transfer warnings do not apply: there is no recipient to be on the wrong network, because the
 * outputs are the dApp's and this wallet did not choose them. What replaces them is the fact that the
 * *contents* are not ours to describe.
 */
export type MidnightFundingWarning =
  /**
   * This wallet can state what the transaction takes from it, and not what else it does.
   *
   * Always raised. The transaction carries the dApp's own intents — contract calls, outputs to
   * addresses we did not pick — and nothing on this rail renders them. Funding it authorises the
   * inputs below and, by way of the sponsor, the fee for the whole thing. Anyone approving this is
   * trusting the page, and the review has to say so rather than imply a completeness it does not have.
   */
  | 'contents-not-described'
  /** Funding it leaves nothing of that token on this rail. Only against a balance actually known. */
  | 'funds-entire-balance'
  /**
   * This wallet holds less of a token than the transaction owes, so it cannot be funded at all.
   *
   * Raised only against a balance that is actually known — `null` is "not synced", never "not enough".
   * A screen that let someone approve this would take them through biometrics to reach a failure the
   * model could already see, which is why it is stated here rather than discovered at signing.
   */
  | 'cannot-cover'

export type MidnightFundingDraft = {
  /** The Midnight network the wallet is reading. */
  readonly network: string
  /** The page that composed the transaction. Rendered as unverified, always. */
  readonly origin: string
  readonly legs: readonly MidnightFundingLeg[]
  readonly fee: MidnightFeePayer
}

/**
 * Funding a transaction a dApp composed, about to be signed.
 *
 * A sibling of {@link MidnightConfirmView} rather than a mode of it, for the reason the module header
 * gives: a funding has **no recipient**. Stretching the transfer view to cover it would mean a
 * required `recipient` field holding something invented, which is exactly the "render a field that
 * cannot exist" case the union exists to prevent.
 *
 * Unshielded only — a shielded deficit is refused natively — so there is no rail to carry and nothing
 * to prove.
 */
export type MidnightFundingView = {
  readonly mode: 'funding'
  readonly network: string
  readonly origin: string
  readonly legs: readonly MidnightFundingLeg[]
  /** Sum of what is owed, per token type — what the user is being asked to contribute. */
  readonly totalByToken: ReadonlyMap<string, bigint>
  readonly fee: MidnightFeePayer
  readonly warnings: readonly MidnightFundingWarning[]
}

/**
 * Build the funding review.
 *
 * Totals are summed **per token type** across segments rather than reported per leg, because that is
 * the figure a person can act on: one transaction can owe the same token in two segments, and two
 * separate rows saying 3 NIGHT do not add up to the 6 that leaves the wallet.
 */
export const reviewMidnightFunding = (draft: MidnightFundingDraft): MidnightFundingView => {
  const totalByToken = new Map<string, bigint>()
  for (const leg of draft.legs) {
    totalByToken.set(leg.tokenType, (totalByToken.get(leg.tokenType) ?? 0n) + leg.owed)
  }

  // Unconditional, and that is the point: it is a property of the request, not of a suspicious one.
  const warnings: MidnightFundingWarning[] = ['contents-not-described']
  let entire = false
  let short = false
  for (const [tokenType, total] of totalByToken) {
    const known = draft.legs.find((leg) => leg.tokenType === tokenType && leg.balance !== null)?.balance
    if (known === undefined || known === null) continue
    // Exclusive: at exact equality the funding is affordable *and* spends everything, which is the
    // whole-balance case. Above it there is nothing to spend everything of.
    if (total > known) short = true
    else if (total === known) entire = true
  }
  if (entire) warnings.push('funds-entire-balance')
  if (short) warnings.push('cannot-cover')

  return {
    mode: 'funding',
    network: draft.network,
    origin: draft.origin,
    legs: draft.legs,
    totalByToken,
    fee: draft.fee,
    warnings,
  }
}

/** Build the detail view for a transaction the chain has already seen. */
export const viewMidnightActivity = (params: {
  readonly tx: MidnightSettledTransaction
  readonly rail: MidnightRail
  readonly network: string
}): MidnightDetailView => ({
  mode: 'detail',
  rail: params.rail,
  network: params.network,
  hash: params.tx.hash,
  ...(params.tx.timestamp === undefined ? {} : {timestamp: params.tx.timestamp}),
  ...(params.tx.blockHeight === undefined ? {} : {blockHeight: params.tx.blockHeight}),
  direction: params.tx.direction,
  netByToken: params.tx.netByToken,
  ...(params.tx.fee === undefined ? {} : {fee: params.tx.fee}),
  counterparties: params.tx.counterparties,
  ourSpentCount: params.tx.ourSpentCount,
  ourCreatedCount: params.tx.ourCreatedCount,
  // A block height is the only evidence of inclusion we have here. No height means the indexer has
  // the transaction but no block for it yet.
  confirmed: params.tx.blockHeight !== undefined,
})

/**
 * One address's whole part in a transaction — what it puts in, and what comes back to it.
 *
 * ⚠️ **Net per token, not "inputs" and "outputs" separately.** Change is an output back to a payer, so
 * a review that listed the two sides would show a wallet paying 5 NIGHT and receiving 3 and leave the
 * arithmetic to the reader. The net is the figure a person acts on, and for a co-funded transaction it
 * is the only one that says whose money is whose.
 */
export type MidnightTxParty = {
  /** The 32-byte `UserAddress`, hex — the vocabulary both facts readers report owners in. */
  readonly address: string
  /**
   * How to name this address on screen, or `null` for one this device does not hold.
   *
   * ⚠️ `null` is "not one of ours **that we know of**". A wallet whose addresses were not supplied
   * reads as a stranger, which is why {@link MidnightTransactionView.understood} is false in that case
   * — see `MidnightEffectGap.own-addresses-unknown`.
   */
  readonly name: string | null
  /** Signed atomic totals per token: negative paid out, positive received. Zero nets are omitted. */
  readonly netByToken: ReadonlyMap<string, bigint>
  /** Which way the value went for this address, across every token. */
  readonly role: 'pays' | 'receives' | 'both'
}

/**
 * Hazards specific to reviewing a transaction that already exists.
 *
 * ⚠️ **Separate from the transfer warnings on purpose.** Those are about an *intent* the wallet is
 * about to build; these are about bytes it has been handed. There is no "recipient on another network"
 * here, because the recipient is whatever the transaction says — but there is a *transaction* on
 * another network, which is a different fact with a different remedy.
 */
export type MidnightTransactionWarning =
  /**
   * The figures below were computed from part of the transaction.
   *
   * ⚠️ Always first, and load-bearing: a partial view produces numbers that are wrong rather than
   * rough. {@link MidnightTransactionView.gaps} says which part could not be read.
   */
  | 'effect-not-understood'
  /**
   * The transaction names a different Midnight network than this wallet is on.
   *
   * Raised only when the transaction actually stated one — an unread network id is no claim, and
   * warning on it would fire on every transaction the ledger's JS reader produced.
   */
  | 'transaction-on-another-network'
  /**
   * A shielded offer rode along, so some of what moves is encrypted.
   *
   * The wallet can open its own shielded outputs and nobody else's. Approving this authorises value
   * this review cannot name.
   */
  | 'shielded-amounts-hidden'
  /**
   * The transaction calls a contract, and what the call does is not described here.
   *
   * The same admission {@link MidnightFundingWarning}'s `contents-not-described` makes: a call's
   * declared effects can move value beyond the offers this review reads.
   */
  | 'calls-not-described'
  /** An action this reader could not name at all — counted, and worth saying rather than omitting. */
  | 'unnamed-actions'
  /**
   * This wallet is neither paying nor being paid, and is still being asked to approve it.
   *
   * Legitimate for a submit-only relay, and exactly the shape a transaction that should not be signed
   * has. Stated rather than guessed at.
   */
  | 'nothing-of-ours-moves'
  /** The expiry every signature is taken over has already passed, so the node would refuse it. */
  | 'already-expired'

/** Facts worth stating that are not hazards — see {@link MidnightTransferNote}. */
export type MidnightTransactionNote =
  /** Several wallets are funding this together, which is what a co-funded send is. */
  | 'several-contributors'
  /** More than one segment, so more than one independently-balanced part rides along. */
  | 'several-segments'
  /** Every party to it is a wallet on this device — a move between your own, not a payment out. */
  | 'entirely-between-our-wallets'

export type MidnightTransactionDraft = {
  /** The Midnight network the wallet is reading. */
  readonly network: string
  /** Who handed over these bytes. Rendered as unverified, always. */
  readonly origin: string
  /** What the transaction contains, read from it — `./midnight-facts.js`. */
  readonly facts: MidnightTxFacts
  /** What it does to this device, read from those facts — `./midnight-effect.js`. */
  readonly effect: MidnightTxEffect
  /**
   * Names for the addresses this device holds, keyed by the 32-byte `UserAddress` hex.
   *
   * ⚠️ **This is what makes "whose money is whose" answerable.** Without it every contributor to a
   * co-funded transaction is a stranger, and the review would report the other wallets' inputs as
   * money leaving to somewhere nobody chose.
   */
  readonly ourNames: ReadonlyMap<string, string>
  readonly fee: MidnightFeePayer
  /** Unix seconds, for the expiry check. Passed in rather than read, so the rule stays pure. */
  readonly nowSecs: number
}

/**
 * A transaction that already exists, about to be approved.
 *
 * A third constructor beside {@link reviewMidnightTransfer} and {@link reviewMidnightFunding}, for the
 * case neither covers: the bytes are built, and what they do is read from them rather than restated
 * from the request. `docs/MIDNIGHT_REVIEW_FROM_BYTES.md` has the argument.
 */
export type MidnightTransactionView = {
  readonly mode: 'transaction'
  readonly network: string
  readonly origin: string
  /** The network the transaction itself names, or `''` where it did not say. */
  readonly transactionNetwork: string
  /**
   * What this device's wallets net, per token — negative out, positive in.
   *
   * ⚠️ Read {@link understood} first. This is the sum over the addresses `ourNames` supplied, and with
   * an incomplete set it is a smaller number than the truth rather than an approximate one.
   */
  readonly delta: ReadonlyMap<string, bigint>
  /** Every address the transaction names, ours and not, with its own net. Largest payer first. */
  readonly parties: readonly MidnightTxParty[]
  readonly calls: readonly {readonly address: string; readonly entryPoint: string}[]
  readonly deploys: readonly {readonly address: string}[]
  /** How many segments it touches. More than one means several independently-balanced parts. */
  readonly segments: number
  /** Shielded outputs, **counted only** — their amounts are encrypted. */
  readonly shieldedOutputs: number
  /** The earliest expiry any intent carries, unix seconds, or `null` where none was readable. */
  readonly expiresAtSecs: number | null
  readonly fee: MidnightFeePayer
  readonly understood: boolean
  readonly gaps: readonly MidnightEffectGap[]
  readonly warnings: readonly MidnightTransactionWarning[]
  readonly notes: readonly MidnightTransactionNote[]
}

const netInto = (into: Map<string, Map<string, bigint>>, address: string, colour: string, by: bigint): void => {
  const forAddress = into.get(address) ?? new Map<string, bigint>()
  const next = (forAddress.get(colour) ?? 0n) + by
  if (next === 0n) forAddress.delete(colour)
  else forAddress.set(colour, next)
  if (forAddress.size === 0) into.delete(address)
  else into.set(address, forAddress)
}

const roleOf = (netByToken: ReadonlyMap<string, bigint>): MidnightTxParty['role'] => {
  let pays = false
  let receives = false
  for (const net of netByToken.values()) {
    if (net < 0n) pays = true
    if (net > 0n) receives = true
  }
  return pays && receives ? 'both' : receives ? 'receives' : 'pays'
}

/** What one party paid out, for ordering. Payers first, largest first — the money is the story. */
const paidBy = (party: MidnightTxParty): bigint => {
  let total = 0n
  for (const net of party.netByToken.values()) if (net < 0n) total -= net
  return total
}

/**
 * Build the review for a transaction that already exists.
 *
 * ⚠️ **Nothing here is taken from a caller's description of the transaction.** `facts` and `effect`
 * both derive from the bytes; the only things this adds are the wallet's own names and the clock. A
 * co-funded transaction reviewed this way shows each contributor's own figure because the *offer*
 * says who owns each input — not because the composer said so.
 */
export const reviewMidnightTransaction = (draft: MidnightTransactionDraft): MidnightTransactionView => {
  const {facts, effect} = draft

  const nets = new Map<string, Map<string, bigint>>()
  for (const intent of facts.intents) {
    for (const section of [intent.guaranteed, intent.fallible]) {
      // An entry whose owner would not read is left out of the per-party breakdown and counted as a
      // gap by `midnightTxEffect` — attributing it to the empty address would invent a party.
      for (const utxo of section.inputs) if (utxo.owner !== '') netInto(nets, utxo.owner, utxo.colour, -utxo.value)
      for (const utxo of section.outputs) if (utxo.owner !== '') netInto(nets, utxo.owner, utxo.colour, utxo.value)
    }
  }

  const parties: MidnightTxParty[] = [...nets.entries()]
    .map(([address, netByToken]) => ({
      address,
      name: draft.ourNames.get(address) ?? null,
      netByToken,
      role: roleOf(netByToken),
    }))
    .sort((a, b) => {
      const paid = paidBy(b) - paidBy(a)
      // Address as the tiebreak, so the order is stable rather than insertion-dependent — a review
      // whose rows moved between renders would be read as changing.
      return paid === 0n ? a.address.localeCompare(b.address) : paid > 0n ? 1 : -1
    })

  const expiries = facts.intents.map((intent) => intent.ttlSecs).filter((ttl): ttl is number => ttl !== null)
  // The earliest, because that is when the transaction stops being submittable — a later intent's
  // longer window does not extend it.
  const expiresAtSecs = expiries.length === 0 ? null : Math.min(...expiries)

  const warnings: MidnightTransactionWarning[] = []
  if (!effect.understood) warnings.push('effect-not-understood')
  if (facts.networkId !== '' && facts.networkId !== draft.network) warnings.push('transaction-on-another-network')
  if (facts.hasShielded) warnings.push('shielded-amounts-hidden')
  if (effect.calls.length > 0) warnings.push('calls-not-described')
  if (facts.intents.some((intent) => intent.otherActions > 0)) warnings.push('unnamed-actions')
  if (expiresAtSecs !== null && expiresAtSecs <= draft.nowSecs) warnings.push('already-expired')
  // Only against a set we actually have: with no addresses of our own everything reads as a
  // stranger's, and this would fire on every transaction while saying nothing.
  const ourAddressesKnown = draft.ourNames.size > 0
  if (ourAddressesKnown && effect.delta.size === 0 && !facts.hasShielded) warnings.push('nothing-of-ours-moves')

  const payers = parties.filter((party) => party.role !== 'receives')
  const notes: MidnightTransactionNote[] = []
  if (payers.length > 1) notes.push('several-contributors')
  if (effect.segments > 1) notes.push('several-segments')
  if (ourAddressesKnown && parties.length > 0 && parties.every((party) => party.name !== null)) {
    notes.push('entirely-between-our-wallets')
  }

  return {
    mode: 'transaction',
    network: draft.network,
    origin: draft.origin,
    transactionNetwork: facts.networkId,
    delta: effect.delta,
    parties,
    calls: effect.calls,
    deploys: effect.deploys,
    segments: effect.segments,
    shieldedOutputs: facts.shieldedOutputs,
    expiresAtSecs,
    fee: draft.fee,
    understood: effect.understood,
    gaps: effect.gaps,
    warnings,
    notes,
  }
}
