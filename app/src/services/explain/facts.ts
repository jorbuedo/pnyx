/**
 * Reduces a reviewed transaction to the bounded, redacted facts an on-device model
 * is allowed to see (Phase 14 item 38).
 *
 * Pure: no React, no storage, no model. This is where the untrusted-input rules are
 * enforced, so it is deliberately the most testable part of the feature.
 *
 * ### Three rules, and why each exists
 *
 * 1. **Bounded.** A transaction can carry 128 inputs and hundreds of assets. The
 *    model's context is small and its cost grows with input, so every list here is
 *    capped — and what was dropped is *reported* (`truncated`) rather than silently
 *    cut, because a summary built from a silently-truncated fact set reads as
 *    complete when it is not.
 * 2. **Redacted.** No full addresses. A counterparty is a count and a tier, not a
 *    bech32 string: an address adds nothing a user-facing explanation can use, and
 *    every byte of it is context spent.
 * 3. **Untrusted text quarantined.** Asset names and transaction metadata are
 *    author-controlled — the same strings the review screen already treats as
 *    hostile. They are included (dev-lead call 2026-07-31: they are the most useful
 *    thing in an explanation) but only inside {@link ExplainFacts.untrusted}, so the
 *    prompt builder can frame them as data rather than instruction.
 *
 * @module
 */

import type {ReviewedOperation, ReviewedTransaction, TransactionWarning} from '@pnyx/tx-review'
import type {CeremonySummary} from '../../screens/cardano/ceremony-summary'
import {metadataEntries, metadataMessageLines} from '../cardano/metadata/entries'
import {type ContextPackId, detectContextPacks} from './context-packs'

/** Caps. Small on purpose — an explanation does not improve past a handful of each. */
export const MAX_ASSETS = 8
export const MAX_UNTRUSTED = 8
/**
 * Lower than the others because an operation is a sentence, not a line item: each renders to
 * several times an asset line's length, and a transaction needing more than six explained is one
 * no two-or-three-sentence summary was going to serve anyway.
 */
export const MAX_OPERATIONS = 6

/** Where an author-controlled string came from. Never rendered as authoritative. */
export type UntrustedSource = 'asset-name' | 'tx-metadata'

export type UntrustedText = {
  readonly source: UntrustedSource
  /** Verbatim. Framing is the prompt builder's job, not this module's. */
  readonly value: string
}

/**
 * One operation, reduced to what an explanation can use.
 *
 * Redacted like everything else here: a credential becomes a short prefix, never a full hash, and
 * nothing carries an address. The prompt turns these into sentences — see `OPERATIONS` there, the
 * total record that makes a new IR operation fail to compile until someone words it.
 */
export type ExplainOperation = {
  readonly kind: ReviewedOperation['kind']
  /** Base units, where the operation has a figure of its own: a deposit, a withdrawal, collateral. */
  readonly lovelace?: string
  /** Short prefix of the pool, DRep or credential it names — enough to say "the same one", never to resolve. */
  readonly targetShort?: string
  /** A reward withdrawal from the owner's own reward account, rather than somebody else's. */
  readonly own?: boolean
  readonly epoch?: string
  /** Votes, proposals or collateral inputs, depending on the kind. */
  readonly count?: number
}

/** A net movement for one asset, from the signing wallet's point of view. */
export type ExplainDelta = {
  /** `null` is the chain coin (ADA); otherwise `policyHex.assetNameHex`. */
  readonly assetId: string | null
  /** Signed, base units, as a string — `bigint` does not survive JSON. */
  readonly delta: string
  /**
   * The creator-chosen name for this asset, when one resolved.
   *
   * Attached to the amount rather than listed separately. The first version put the
   * amounts (with raw hex ids) in one place and the names in the untrusted block with
   * nothing linking them, and the model paired them wrongly — reporting 1,552,069 of a
   * token that there was one of. Quarantine is about *framing*, not physical distance:
   * the prompt still marks every one of these unverified.
   */
  readonly nameUnverified: string | null
}

export type ExplainFacts = {
  readonly chain: 'cardano'
  /** Absent on an unsigned body; the explain feature only runs on settled history. */
  readonly status: 'pending' | 'confirmed' | 'failed' | 'unknown'
  /** Fee in lovelace, as a string. */
  readonly feeLovelace: string
  /** What the transaction did to the signing wallet, capped at {@link MAX_ASSETS}. */
  readonly ownDeltas: readonly ExplainDelta[]
  /**
   * What each external counterparty walked away with.
   *
   * The IR's own `counterparties` field, not a recount of parties. Previously this was
   * a bare number, which is why a Mint explained itself as bland: the facts could say
   * "two other parties" but never that one of them received the 1,000 tokens the
   * transaction had just created.
   *
   * Still no addresses — a counterparty is what it received plus, when the user has
   * saved one, their own name for it.
   */
  readonly counterparties: readonly ExplainCounterparty[]
  readonly ownParties: number
  /**
   * Script addresses delegating to one of the owner's stake credentials.
   *
   * "Escrow" is this codebase's word, not a term the reader or the model knows, so the prompt
   * spends a clause explaining it rather than passing the count bare.
   */
  readonly escrowParties: number
  /**
   * The forum identity's own addresses — the owner's, but a different seed.
   *
   * The IR keeps this tier separate deliberately and the facts dropped it entirely, so anything
   * involving the identity wallet read to the model as a stranger's.
   */
  readonly identityParties: number
  /**
   * Signatures the transaction carries, against the credentials it explicitly demands.
   *
   * `null` when no witness set was supplied — which is the pre-sign case, where nothing has been
   * signed yet and `outcome.quorum` describes the co-signing instead. On settled history this is
   * how an explanation can say a transaction was co-signed at all: the `multi-sig` warning says
   * only that one was needed, in the present tense, about something already done.
   */
  readonly signatures: {readonly present: number; readonly required: number} | null
  /**
   * What the transaction did beyond moving value, with the part of each operation worth saying.
   *
   * ⚠️ Not bare kinds. This was `readonly string[]`, comma-joined into the prompt as slugs, and
   * `SYSTEM_RULES` still carries a rule forbidding the model to read them aloud — we were asking
   * it to supply meaning we had withheld, and betting a small on-device model knew what
   * `stake-vote-reg-delegation` was. The payloads dropped at this boundary included the ones that
   * are money: the amount a reward withdrawal took, the deposit a registration locked, and the
   * collateral a contract put at risk.
   */
  readonly operations: readonly ExplainOperation[]
  /**
   * Assets created or destroyed, whoever ended up with them.
   *
   * Carried separately from {@link ownDeltas} because a mint is frequently the whole
   * point of a transaction while changing our balance by nothing but the fee — the
   * newly minted tokens can go straight to another address. Without this the facts
   * said only "minting happened" and an explanation could not say what was minted.
   */
  readonly minted: readonly {
    readonly policyIdHex: string
    readonly assetNameHex: string
    readonly quantity: string
    readonly burn: boolean
  }[]
  /** The review IR's own warnings — already a closed union, so safe to pass through. */
  readonly warnings: readonly TransactionWarning[]
  readonly untrusted: readonly UntrustedText[]
  /**
   * Protocol knowledge this transaction earns, by id — see `context-packs.ts`.
   *
   * Ids rather than prose: this module decides *what applies*, the prompt decides how it reads,
   * exactly as with warnings. Empty for an ordinary transfer, which is the point — the knowledge
   * costs context only where it explains something.
   */
  readonly contextPacks: readonly ContextPackId[]
  /** What the caps dropped. Non-zero means the facts are a partial view. */
  readonly truncated: {
    readonly assets: number
    readonly untrusted: number
    readonly operations: number
  }
}

/**
 * Whether the transaction moves nothing and only pays its own fee.
 *
 * The common self-send / consolidation shape, where `ownDeltas` expresses the whole
 * transaction as a single outflow exactly equal to the fee. Shared rather than computed
 * per consumer because the prompt and the structured-output verifier must agree on it:
 * if the prompt tells the model "nothing is sent" while the verifier expects `sent`,
 * every fee-only explanation is rejected as a mismatch.
 */
export const isFeeOnly = (facts: ExplainFacts): boolean => {
  const only = facts.ownDeltas.length === 1 ? facts.ownDeltas[0] : undefined
  return (
    only !== undefined &&
    only.assetId === null &&
    only.delta === `-${facts.feeLovelace}` &&
    facts.counterparties.every((c) => c.received.length === 0)
  )
}

/**
 * One external party and what they received.
 *
 * `label` is the user's **own** name for the address from their address book. Unlike a
 * token name it is not attacker-authored — the user typed it — so it is stated as fact
 * rather than quarantined. Absent when the address is not saved.
 */
export type ExplainCounterparty = {
  readonly known: KnownAddress | null
  readonly received: readonly ExplainDelta[]
}

/**
 * What the app can say about a counterparty address without asking anyone.
 *
 * `own-wallet` is the one that changes an explanation most: money moving to another
 * wallet the same person controls has not left their control, and calling that "sent
 * to another address" is technically true and materially misleading.
 */
export type KnownAddress = {
  readonly kind: 'contact' | 'own-wallet'
  /** The user's own name for it — their contact label, or the wallet's name. */
  readonly label: string
}

/** Names the caller resolved for the assets in this transaction (`assetId` → name). */
export type AssetNames = ReadonlyMap<string, string>

/** Address book plus the user's other wallets: bech32 → what we can say about it. */
export type KnownAddresses = ReadonlyMap<string, KnownAddress>

/**
 * The wallet's net position change, straight from the IR.
 *
 * `ReviewedTransaction.ownDelta` is the canonical answer — own outputs − own
 * inputs — and it is what the review screen itself renders. An
 * earlier version recomputed this by summing `ownGroup.parties` sent/received, which
 * looked equivalent and was not: **minted assets never appear in a party's received**,
 * because they come from a policy rather than from an input. A mint therefore
 * explained itself as "sent 5 ADA" with no mention of the token it created.
 *
 * The fee is implicit in these figures (paying it reduces the change output), so it
 * must never be presented as an additional cost on top — see `prompt.ts`.
 */
const ownDeltasOf = (reviewed: ReviewedTransaction): readonly ExplainDelta[] =>
  [...reviewed.ownDelta]
    .filter((amount) => amount.quantity !== 0n)
    // Largest absolute movement first: if the cap bites, it drops the least significant.
    .sort((a, b) => {
      const magA = a.quantity < 0n ? -a.quantity : a.quantity
      const magB = b.quantity < 0n ? -b.quantity : b.quantity
      return magA === magB ? 0 : magB > magA ? 1 : -1
    })
    .map((amount) => ({
      assetId: amount.assetId ?? null,
      delta: amount.quantity.toString(),
      nameUnverified: null,
    }))

/** First bytes only: enough for the model to say "the same one", never enough to resolve. */
const short = (hex: string): string => hex.slice(0, 8)

const drepTarget = (drep: {
  readonly type: string
  readonly keyHashHex?: string
  readonly scriptHashHex?: string
}): string | undefined => {
  if (drep.type === 'key_hash' && drep.keyHashHex !== undefined) return short(drep.keyHashHex)
  if (drep.type === 'script_hash' && drep.scriptHashHex !== undefined) return short(drep.scriptHashHex)
  // `abstain` and `no_confidence` are the choice itself, not a party — the prompt words them.
  return undefined
}

/**
 * The part of each operation worth an explanation, redacted.
 *
 * Deliberately lossy and deliberately typed by `kind`: the prompt renders from a total record, so
 * anything not extracted here simply cannot be said, and the compiler will not let a new operation
 * kind go unworded.
 */
const explainOperations = (reviewed: ReviewedTransaction): readonly ExplainOperation[] =>
  reviewed.operations.map((op): ExplainOperation => {
    switch (op.kind) {
      case 'stake-registration':
      case 'stake-deregistration':
      case 'drep-deregistration':
        return {kind: op.kind, lovelace: op.deposit.toString(), targetShort: short(op.credential.hashHex)}
      case 'stake-delegation':
        return {kind: op.kind, targetShort: short(op.poolKeyHashHex)}
      case 'vote-delegation': {
        const target = drepTarget(op.drep)
        return {kind: op.kind, ...(target === undefined ? {} : {targetShort: target})}
      }
      case 'reward-withdrawal':
        return {kind: op.kind, lovelace: op.amount.toString(), own: op.own}
      case 'pool-retirement':
        return {kind: op.kind, targetShort: short(op.poolKeyHashHex), epoch: op.epoch.toString()}
      case 'pool-registration':
        return {kind: op.kind, targetShort: short(op.poolKeyHashHex), lovelace: op.deposit.toString()}
      case 'voting-procedures':
        return {kind: op.kind, count: op.votes.length}
      case 'proposal-procedures':
        return {kind: op.kind, count: op.proposals.length}
      case 'contract-execution':
        return {
          kind: op.kind,
          count: op.collateralInputs,
          ...(op.totalCollateral === undefined ? {} : {lovelace: op.totalCollateral.toString()}),
        }
      // Minting is carried by `minted`, which says what was created; the rest name no figure.
      default:
        return {kind: op.kind}
    }
  })

/**
 * The operations to explain, bounded.
 *
 * IR order is kept whenever everything fits, because a certificate sequence often reads as one —
 * register, then delegate. Only when something must be dropped does this prefer operations that
 * state a figure: a withdrawal's amount and a registration's deposit are money that appears
 * nowhere else in the facts, and losing one to the third repetition of a certificate kind would
 * be silent and expensive.
 */
const cappedOperations = (all: readonly ExplainOperation[]): readonly ExplainOperation[] => {
  if (all.length <= MAX_OPERATIONS) return all
  const withFigure = all.filter((op) => op.lovelace !== undefined)
  const rest = all.filter((op) => op.lovelace === undefined)
  return [...withFigure, ...rest].slice(0, MAX_OPERATIONS)
}

/**
 * Signatures present against credentials explicitly demanded, or `null` before anything is signed.
 *
 * `requiredSigners` is the transaction's own demand (body key 14), which is what a shared wallet
 * uses; it is not the same as the quorum a script enforces, and the prompt says only what this
 * counts rather than implying it read the script.
 */
const signaturesOf = (reviewed: ReviewedTransaction): {present: number; required: number} | null =>
  reviewed.witnessSet === undefined
    ? null
    : {
        present: reviewed.witnessSet.length + (reviewed.bootstrapWitnesses ?? 0),
        required: reviewed.requiredSigners.length,
      }

/**
 * Human-readable metadata, via the same decoder the review screen renders.
 *
 * The hand-rolled version this replaces walked top-level strings and string arrays, so
 * it silently dropped **every CIP-20 memo** — those are `{"674": {"msg": [...]}}`, a
 * nested object. A user who attached a note to a send saw it on the review screen and
 * watched the explanation ignore it.
 *
 * `metadataMessageLines` also rejoins messages chunked across the 64-byte limit, which
 * an ad-hoc reader would have surfaced as fragments.
 */
const metadataStrings = (metadata: Record<string, unknown>): readonly string[] => {
  const memo = metadataMessageLines(metadata)
  if (memo !== null) return memo
  // No CIP-20 memo: fall back to any other label that decoded to readable lines.
  return metadataEntries(metadata).flatMap((entry) => entry.lines.filter((l) => l.trim().length > 0))
}

/**
 * Build the model's view of a transaction.
 *
 * `names` is supplied by the caller (the token-metadata layer) rather than read here,
 * so this module stays pure and the untrusted strings arrive through one door.
 */
/** Attach the resolved name to each amount, so the two can never be paired wrongly. */
const named = (deltas: readonly ExplainDelta[], names: AssetNames): readonly ExplainDelta[] =>
  deltas.map((d) => ({
    ...d,
    nameUnverified: d.assetId === null ? null : (names.get(d.assetId) ?? null),
  }))

export const explainableFactsOf = (
  reviewed: ReviewedTransaction,
  names: AssetNames = new Map(),
  known: KnownAddresses = new Map(),
  // Passed in because recognising a CIP-113 transfer needs the deployment record, which is
  // configuration rather than anything the reviewed transaction carries.
  options: {readonly isCip113?: boolean} = {},
): ExplainFacts => {
  const allDeltas = ownDeltasOf(reviewed)
  const ownDeltas = named(allDeltas.slice(0, MAX_ASSETS), names)

  // Asset names live on the amounts now (see ExplainDelta.nameUnverified); this block
  // carries only transaction metadata, which belongs to no particular amount.
  const untrustedAll: UntrustedText[] = []
  for (const value of metadataStrings(reviewed.metadata)) {
    untrustedAll.push({source: 'tx-metadata', value})
  }
  const untrusted = untrustedAll.slice(0, MAX_UNTRUSTED)

  // All four tiers, because the counts below are per-tier and an escrow or identity
  // party must not be counted as a counterparty.
  const minted = reviewed.operations.flatMap((op) =>
    op.kind === 'minting'
      ? op.assets.map((a) => ({
          policyIdHex: op.policyIdHex,
          assetNameHex: a.assetNameHex,
          quantity: (a.quantity < 0n ? -a.quantity : a.quantity).toString(),
          burn: a.quantity < 0n,
        }))
      : [],
  )

  const allOperations = explainOperations(reviewed)

  const parties = [
    ...reviewed.ownGroup.parties,
    ...reviewed.identityGroup.parties,
    ...reviewed.escrowGroup.parties,
    ...reviewed.otherGroup.parties,
  ]

  return {
    chain: 'cardano',
    status: reviewed.status ?? 'unknown',
    feeLovelace: reviewed.fee.toString(),
    ownDeltas,
    counterparties: reviewed.counterparties.slice(0, MAX_ASSETS).map((c) => ({
      known: (c.address.bech32 === undefined ? undefined : known.get(c.address.bech32)) ?? null,
      received: named(
        c.received
          .filter((a) => a.quantity !== 0n)
          .map((a) => ({assetId: a.assetId ?? null, delta: a.quantity.toString(), nameUnverified: null})),
        names,
      ),
    })),
    ownParties: parties.filter((p) => p.ownership.level === 'own').length,
    escrowParties: parties.filter((p) => p.ownership.level === 'escrow').length,
    operations: cappedOperations(allOperations),
    minted: minted.slice(0, MAX_ASSETS),
    warnings: reviewed.warnings,
    untrusted,
    contextPacks: detectContextPacks(reviewed, options),
    identityParties: reviewed.identityGroup.parties.length,
    signatures: signaturesOf(reviewed),
    truncated: {
      assets: allDeltas.length - ownDeltas.length,
      untrusted: untrustedAll.length - untrusted.length,
      operations: allOperations.length - cappedOperations(allOperations).length,
    },
  }
}

/**
 * Facts for a whole signing ceremony — one confirm that may authorise several
 * transactions plus message signatures.
 *
 * Built from `summarizeCeremony`, the same aggregation the review screen renders, so
 * the explanation and the screen cannot disagree about the totals. Its `sent`/`received`
 * split is self-correcting for a chain: leg A's change is an own output in A and an own
 * input in B, so the intermediate cancels.
 */
export type ExplainCeremonyFacts = {
  /** The aggregate, as if the batch were one transaction. */
  readonly overall: ExplainFacts
  /** How many transactions the single confirm authorises. */
  readonly transactionCount: number
  /** How many arbitrary-payload signatures it authorises alongside them. */
  readonly messageCount: number
  /**
   * True when more than one transaction is submitted.
   *
   * The fact that matters to the person confirming: the legs are signed together but
   * broadcast one after another with no rollback, so a later failure leaves the earlier
   * ones on chain. `signWithCeremony` reports exactly that via the completed legs on
   * `SigningSequenceError`.
   */
  readonly submittedInSequence: boolean
}

/**
 * Reduce a ceremony to explainable facts.
 *
 * `summary` comes from `summarizeCeremony(transactionLegs)`; `first` is the leg whose
 * status and metadata stand for the batch (they share a producer, so they share both).
 */
export const explainableCeremonyFactsOf = (params: {
  readonly summary: CeremonySummary
  readonly first: ReviewedTransaction
  readonly isCip113?: boolean
  readonly messageCount: number
  readonly names?: AssetNames
  readonly known?: KnownAddresses
}): ExplainCeremonyFacts => {
  const {summary, first, messageCount, names = new Map(), known = new Map()} = params

  // The summary splits sent/received; the model wants one signed net per asset.
  const totals = new Map<string, bigint>()
  for (const a of summary.received) totals.set(a.assetId ?? '', (totals.get(a.assetId ?? '') ?? 0n) + a.quantity)
  for (const a of summary.sent) totals.set(a.assetId ?? '', (totals.get(a.assetId ?? '') ?? 0n) - a.quantity)

  const ownDeltas = [...totals.entries()]
    .filter(([, q]) => q !== 0n)
    .slice(0, MAX_ASSETS)
    .map(([assetId, q]) => ({
      assetId: assetId === '' ? null : assetId,
      delta: q.toString(),
      nameUnverified: assetId === '' ? null : (names.get(assetId) ?? null),
    }))

  const ceremonyOperations = explainOperations({...first, operations: summary.operations})

  const overall: ExplainFacts = {
    chain: 'cardano',
    // From the leg the ceremony is named after, which is the one the other facts describe. A
    // union across legs would attach a protocol's context to a batch whose other transactions
    // have nothing to do with it.
    contextPacks: detectContextPacks(first, {isCip113: params.isCip113 === true}),
    identityParties: first.identityGroup.parties.length,
    signatures: signaturesOf(first),
    status: first.status ?? 'unknown',
    feeLovelace: summary.totalFee.toString(),
    ownDeltas,
    counterparties: summary.counterparties.slice(0, MAX_ASSETS).map((c) => ({
      known: (c.bech32 === undefined ? undefined : known.get(c.bech32)) ?? null,
      received: c.received
        .filter((a) => a.quantity !== 0n)
        .map((a) => ({
          assetId: a.assetId ?? null,
          delta: a.quantity.toString(),
          nameUnverified: a.assetId === undefined ? null : (names.get(a.assetId) ?? null),
        })),
    })),
    ownParties: 0,
    escrowParties: 0,
    operations: cappedOperations(ceremonyOperations),
    warnings: summary.warnings,
    minted: summary.operations.flatMap((op) =>
      op.kind === 'minting'
        ? op.assets.map((a) => ({
            policyIdHex: op.policyIdHex,
            assetNameHex: a.assetNameHex,
            quantity: (a.quantity < 0n ? -a.quantity : a.quantity).toString(),
            burn: a.quantity < 0n,
          }))
        : [],
    ),
    // Was hardcoded empty, which dropped a memo on any multi-leg ceremony. The legs
    // share a producer and therefore share metadata, so the first leg's is the batch's.
    untrusted: metadataStrings(first.metadata)
      .slice(0, MAX_UNTRUSTED)
      .map((value) => ({source: 'tx-metadata' as const, value})),
    truncated: {
      assets: Math.max(0, totals.size - ownDeltas.length),
      untrusted: 0,
      operations: ceremonyOperations.length - cappedOperations(ceremonyOperations).length,
    },
  }

  return {
    overall,
    transactionCount: summary.legCount,
    messageCount,
    submittedInSequence: summary.legCount > 1,
  }
}
