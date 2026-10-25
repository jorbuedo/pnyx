/**
 * Pure presentation model for the Cardano tx-review screen — no React, no
 * formatting. Turns a `@pnyx/tx-review` `ReviewedTransaction` into the
 * display decisions the screen renders: which `txReview.titles.*` key, the
 * headline flow direction + amounts, and the ordered warning i18n keys.
 *
 * Formatting (ADA amounts, addresses) stays in the component via `useFormat`;
 * this module only decides *what* to show and *which key*.
 *
 * @module
 */

import {
  isPureRewardWithdrawal,
  type ReviewedAmount,
  type ReviewedTransaction,
  type ReviewedVkeyWitness,
  type TransactionWarning,
} from '@pnyx/tx-review'
import type {TranslationKey} from '../../i18n/types'
import {isNightClaim} from '../../services/cardano/night-redeem'

/** `txReview.titles.*` leaf keys this screen can pick. */
export type ReviewTitleKey =
  | 'send'
  | 'stake'
  | 'stakeAndDelegate'
  | 'unstake'
  | 'delegate'
  | 'withdrawRewards'
  | 'vote'
  | 'governance'
  | 'mint'
  | 'burn'
  | 'contract'
  | 'nightClaim'

/**
 * `txReview.warnings.*` leaf key for each IR warning that deserves a banner.
 *
 * Partial on purpose: an IR warning is not automatically a user-facing alarm.
 * `no-ttl` is the standing example — our own builder never sets a TTL, so it
 * fires on essentially every transaction we make, and a banner that is always
 * on teaches people to ignore banners. It shows as an expiry row in Details
 * instead.
 *
 * ⚠️ **`plutus-contract` and `unresolved-inputs` left for the same reason, on
 * 2026-10-09.** Both describe ordinary structure rather than risk, and both are
 * already on screen as facts: a contract call titles the review "Smart
 * Contract" and fills the Operations and Contracts tabs, and the inputs the
 * wallet could not resolve are listed in UTxOs under their own count. A NIGHT
 * redeem showed three orange banners of which two said only "this is a contract
 * call that spends a contract's UTxO" — which is what a redeem IS. Alarms that
 * fire on the normal case are what make the abnormal one invisible.
 */
export const WARNING_KEY: Partial<Record<TransactionWarning, string>> = {
  'leaked-signing-key': 'leakedSigningKey',
  'large-fee': 'largeFee',
  'change-folded-into-fee': 'changeFoldedIntoFee',
  minting: 'minting',
  burning: 'burning',
  'governance-action': 'governanceAction',
  'unknown-certificate': 'unknownCertificate',
  'script-certificate': 'scriptCertificate',
  'unknown-body-fields': 'unknownBodyFields',
  'treasury-donation': 'treasuryDonation',
  'multi-sig': 'multiSig',
  'stake-credential-reuse': 'stakeCredentialReuse',
  'ends-external-delegation': 'endsExternalDelegation',
  'spends-unconfirmed-input': 'spendsUnconfirmedInput',
}

const hasOp = (reviewed: ReviewedTransaction, kind: ReviewedTransaction['operations'][number]['kind']): boolean =>
  reviewed.operations.some((op) => op.kind === kind)

/**
 * Pick the screen title. Operation-defined intents (governance, staking,
 * mint/burn, contract) win over a plain transfer, most-specific first; a tx with
 * none of those is a `send`. A reward withdrawal is checked **last** and only
 * when it is the transaction's whole story — see `isPureRewardWithdrawal`.
 */
export const reviewTitleKey = (reviewed: ReviewedTransaction): ReviewTitleKey => {
  const kinds = new Set(reviewed.operations.map((op) => op.kind))
  if (kinds.has('proposal-procedures')) return 'governance'
  if (kinds.has('voting-procedures')) return 'vote'
  if (kinds.has('drep-registration') || kinds.has('drep-deregistration') || kinds.has('drep-update'))
    return 'governance'
  if (kinds.has('committee-hot-auth') || kinds.has('committee-cold-resign')) return 'governance'
  if (kinds.has('vote-delegation')) return 'delegate'
  if (
    kinds.has('stake-delegation') ||
    kinds.has('stake-reg-delegation') ||
    kinds.has('stake-vote-delegation') ||
    kinds.has('stake-vote-reg-delegation') ||
    kinds.has('vote-reg-delegation')
  ) {
    return 'delegate'
  }
  if (kinds.has('stake-registration') || kinds.has('stake-deregistration')) return 'stake'
  const mint = reviewed.operations.find((op) => op.kind === 'minting')
  if (mint !== undefined && mint.kind === 'minting') return mint.burns ? 'burn' : 'mint'
  // Before the generic contract title, for the same reason the activity row
  // checks it first: a claim IS a script spend, and "Contract" says nothing.
  if (isNightClaim(reviewed)) return 'nightClaim'
  if (hasOp(reviewed, 'contract-execution')) return 'contract'
  // Checked last and only when it is the whole story: a swept withdrawal must
  // not retitle an outright send (see isPureRewardWithdrawal).
  if (isPureRewardWithdrawal(reviewed)) return 'withdrawRewards'
  return 'send'
}

export type FlowDirection = 'out' | 'in' | 'neutral'

export type ReviewHeadline = {
  readonly direction: FlowDirection
  /** The wallet's net movement; negatives are outflows, positives inflows. */
  readonly amounts: readonly ReviewedAmount[]
}

/**
 * The headline flow: sign of the ADA (coin) delta decides direction; a
 * coin-neutral tx that still moves tokens is `neutral` (certs/votes with no
 * value movement are `neutral` too).
 */
export const reviewHeadline = (reviewed: ReviewedTransaction): ReviewHeadline => {
  const coin = reviewed.ownDelta.find((a) => a.assetId === undefined)
  const direction: FlowDirection =
    coin === undefined || coin.quantity === 0n ? 'neutral' : coin.quantity < 0n ? 'out' : 'in'
  return {direction, amounts: reviewed.ownDelta}
}

/** Warning i18n leaf keys in the IR's order (deduped defensively), minus any the producer expected. */
export const reviewWarningKeys = (
  reviewed: ReviewedTransaction,
  expected: ReadonlySet<TransactionWarning> = new Set(),
): readonly string[] => {
  const seen = new Set<string>()
  const keys: string[] = []
  for (const warning of reviewed.warnings) {
    if (expected.has(warning)) continue
    const key = WARNING_KEY[warning]
    if (key !== undefined && !seen.has(key)) {
      seen.add(key)
      keys.push(key)
    }
  }
  return keys
}

/**
 * Warning keys that survive into `detail` mode.
 *
 * Most warnings exist to inform a signing decision — "runs a smart contract",
 * "large fee", "mints tokens". Once a transaction is on chain there is no
 * decision left, and a screen full of alarms about something that already
 * happened is noise. Two classes stay: those describing *our own rendering* (we
 * could not fully decode this, so do not read an absence as absence), and
 * `leakedSigningKey`, which describes the transaction rather than a choice — a
 * settled transaction is exactly where a burned key gets discovered.
 */
const DETAIL_MODE_WARNINGS: ReadonlySet<string> = new Set([
  'unknownCertificate',
  'unknownBodyFields',
  'leakedSigningKey',
])

/** The warning keys to render for a review surface in `confirm` vs `detail` mode. */
export const warningKeysForMode = (
  reviewed: ReviewedTransaction,
  mode: 'confirm' | 'detail',
  /**
   * Warnings the *producer* knows are definitional for the operation it built.
   *
   * An allowlist, declared per producer and never global: a dApp-supplied
   * transaction declares nothing and keeps every warning, while a first-party
   * flow can say "this one mints by definition" without also muting anything
   * unexpected. Same reasoning as `no-ttl` above — a banner that is always on for
   * an operation teaches the reader to skip the banners that matter.
   */
  expected: ReadonlySet<TransactionWarning> = new Set(),
): readonly string[] => {
  const keys = reviewWarningKeys(reviewed, expected)
  return mode === 'confirm' ? keys : keys.filter((key) => DETAIL_MODE_WARNINGS.has(key))
}

/**
 * `txReview.signatures.role.*` leaf key for a witness — what the left column of
 * a witness row says.
 *
 * Ownership wins over the required-signers list: "this is your key" is the fact
 * the reader acts on, and a key can be both. `external` is a real answer (not
 * ours, not explicitly required), never a stand-in for "we could not tell" —
 * a witness whose key could not be hashed is `unidentified`, because every
 * match against it was unanswerable rather than negative.
 */
export const witnessRoleKey = (witness: ReviewedVkeyWitness): string => {
  if (witness.keyHashHex === undefined) return 'unidentified'
  if (witness.owner === 'wallet') return 'wallet'
  if (witness.owner === 'identity') return 'identity'
  return witness.satisfiesRequiredSigner ? 'requiredSigner' : 'external'
}

/**
 * Whether a required signer's witness is present in the transaction.
 *
 * `null` when there is no witness set at all — an unsigned body says nothing
 * about who has signed, and rendering "Pending" for every signer would invent a
 * state the bytes do not describe.
 */
export const requiredSignerSigned = (reviewed: ReviewedTransaction, keyHashHex: string): boolean | null =>
  reviewed.witnessSet === undefined
    ? null
    : reviewed.witnessSet.some((w) => w.keyHashHex !== undefined && w.keyHashHex === keyHashHex)

/** The total deposit this tx pays (sum of deposit-bearing operations), 0n if none. */
export const totalDeposit = (reviewed: ReviewedTransaction): bigint => {
  let total = 0n
  for (const op of reviewed.operations) {
    if ('deposit' in op) total += op.deposit
  }
  return total
}

/** Whether a `Deposit` row should show (any deposit-bearing operation). */
export const hasDeposit = (reviewed: ReviewedTransaction): boolean => totalDeposit(reviewed) > 0n

/**
 * Whether confirming this review broadcasts the transaction, or only signs it.
 *
 * Two facts, and both are needed. `signOnly` covers the requests that say so
 * themselves — a dApp `signTx`, an air-gap reply, a co-signer's partial pass.
 *
 * A quorum panel covers the one that does not: a shared wallet's *own*
 * transaction reaches the review with `signOnly` unset, because
 * `applyAuthorityToRequest` stamps it later, inside the signing layer. Reading
 * the request alone called that a broadcast — so the button said "Confirm &
 * Send" for a tap that sends nothing and hands the transaction on to be
 * gathered, and the explain prompt told the user it "submits this to the network
 * straight away".
 *
 * `hasQuorum` is the presence of a signature panel, not whether it is satisfied.
 * A met quorum still does not broadcast *here*: submitting is the co-sign
 * screen's own action, one screen later.
 */
export const willBroadcastOnConfirm = (
  payload: {readonly _tag: string; readonly signOnly?: boolean} | undefined,
  hasQuorum: boolean,
): boolean => payload !== undefined && payload._tag === 'CardanoTx' && payload.signOnly !== true && !hasQuorum

/**
 * The i18n key for the review screen's title.
 *
 * ⚠️ **The producer wins.** `ReviewTicket.titleKey` existed, was documented as an override, was
 * set by nine producers — and was read by nothing, so every one of them silently got the derived
 * title instead. A CIP-113 transfer is the case that made it visible: it executes Plutus scripts,
 * so the IR derives `contract` and the screen said "Smart Contract" over what the user was doing,
 * which was sending a token.
 *
 * `isMessage` decides the fallback, not the override: a message leg has no transaction to derive
 * from, but a producer that named its own title still means it.
 */
export const reviewScreenTitleKey = (
  producerTitleKey: TranslationKey | undefined,
  reviewed: ReviewedTransaction | null,
): TranslationKey =>
  producerTitleKey ??
  (reviewed === null ? 'txReview.actions.signMessage' : `txReview.titles.${reviewTitleKey(reviewed)}`)
