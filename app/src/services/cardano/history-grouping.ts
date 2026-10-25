/**
 * Pure helpers for the Activity screen: flatten newest-first
 * `ReviewedTransaction`s into a date-sectioned list for a single virtualized
 * `FlatList`, and classify a tx's activity type for its label + icon. No React,
 * no i18n — the screen threads the active locale and resolves label keys.
 *
 * @module
 */

import type {ReviewedTransaction} from '@pnyx/tx-review'
import {historyDirection, isPureRewardWithdrawal} from '@pnyx/tx-review'
import {type Cip113Action, type Cip113Marks, cip113ActionOf, isProgrammableTokenTx} from './cip113/activity'
import {isNightClaim} from './night-redeem'

/**
 * One day of activity: its header label and the transactions under it.
 *
 * A section is one list item, not one item per row, because the rows share a
 * single painted card — the surface belongs to that card, and a flat
 * `[header, tx, tx, …]` list gave the screen no box to put it on, leaving every
 * row on the bare canvas. Virtualization is therefore per day; a day holds few
 * enough transactions for that to be the cheaper trade.
 */
export type ActivityListItem = {
  readonly kind: 'section'
  readonly id: string
  readonly label: string
  readonly txs: readonly ReviewedTransaction[]
}

/** Activity type — a superset of direction, promoting special operations. */
export type ActivityType =
  | 'sent'
  | 'received'
  | 'self'
  | 'smartContract'
  /** CIP-113: a token registered into the protocol's registry. */
  | 'programmableRegistry'
  /** CIP-113: a registered token created into a smart wallet. */
  | 'programmableIssue'
  /** CIP-113: tokens moved between smart wallets. */
  | 'programmableTransfer'
  /** CIP-113, but an operation we do not name. Better than "Smart Contract", short of a claim. */
  | 'programmableToken'
  | 'staking'
  | 'governance'
  | 'mint'
  | 'rewards'
  /** A NIGHT airdrop claim — treasury (first thaw) or escrow (later thaws). */
  | 'nightClaim'

/** A total map, so a new CIP-113 action cannot be added without deciding how a row reads. */
const PROGRAMMABLE_TYPE: Record<Cip113Action, ActivityType> = {
  registry: 'programmableRegistry',
  issue: 'programmableIssue',
  transfer: 'programmableTransfer',
  other: 'programmableToken',
}

const STAKING_KINDS = new Set([
  'stake-registration',
  'stake-deregistration',
  'stake-delegation',
  'stake-reg-delegation',
  'pool-registration',
  'pool-retirement',
])
const GOV_KINDS = new Set([
  'vote-delegation',
  'stake-vote-delegation',
  'vote-reg-delegation',
  'stake-vote-reg-delegation',
  'committee-hot-auth',
  'committee-cold-resign',
  'drep-registration',
  'drep-deregistration',
  'drep-update',
  'voting-procedures',
  'proposal-procedures',
])

/**
 * A spent input sitting at a script address — the only evidence of a contract
 * call that survives the history path.
 *
 * `contract-execution` is derived from the body's script-data hash, which exists
 * only when reviewing transaction bytes. A synced transaction arrives as an
 * indexer summary carrying no script detail at all, so without this every DEX
 * swap and NFT trade in the list fell through to plain Sent/Received.
 *
 * It under-reports on purpose: a mint whose policy is a script, or a script run
 * for a withdrawal, spends no script UTxO and is not claimed here.
 *
 * ⚠️ **Somebody else's script, not any script.** A CIP-1854 shared wallet lives at a
 * script address, so spending from one is a script spend by this test — and every send
 * from a shared wallet was labelled "Smart Contract", which is wrong twice over: it is a
 * *native* script, not Plutus, and it is the user's own wallet rather than a contract they
 * interacted with. A DEX swap or an NFT trade spends a script UTxO belonging to *someone
 * else*, and that is the case this heuristic was added for.
 *
 * Ownership is the discriminator rather than native-vs-Plutus because a synced row cannot
 * tell those apart: the indexer summary carries no script detail, which is the whole reason
 * this test exists alongside `contract-execution`. Who owns the coin, it does know.
 */
const spendsForeignScriptUtxo = (tx: ReviewedTransaction): boolean =>
  // Optional-chained deliberately: an input with no ownership resolved is treated as
  // foreign, so an unknown falls back to the label this had before rather than silently
  // reclassifying a real contract call as a plain send.
  tx.inputs.some((io) => io.credentials?.payment?.type === 'script' && io.ownership?.level !== 'own')

/**
 * Classify a tx for its row label/icon. Special operations win over the raw
 * money-flow direction (a delegation that also moves ADA reads as "Staking",
 * not "Sent"); a plain transfer falls back to sent/received/self.
 */
export const activityType = (tx: ReviewedTransaction, cip113: Cip113Marks): ActivityType => {
  const kinds = tx.operations.map((o) => o.kind)
  // Checked before the generic contract label: a claim IS a script spend, and
  // "Smart contract" tells the user nothing about what happened.
  if (isNightClaim(tx)) return 'nightClaim'
  // Same reasoning, same position. Required rather than optional so adding a caller cannot quietly
  // opt out of the label by forgetting an argument.
  if (isProgrammableTokenTx(tx, cip113.scriptCredentials)) return PROGRAMMABLE_TYPE[cip113ActionOf(tx, cip113)]
  if (kinds.includes('contract-execution') || spendsForeignScriptUtxo(tx)) return 'smartContract'
  // Only a transaction that does nothing but withdraw reads as "Rewards" —
  // wallets sweep pending rewards into ordinary sends, so the mere presence of
  // a withdrawal would mislabel a plurality of a staking wallet's history.
  if (isPureRewardWithdrawal(tx)) return 'rewards'
  if (kinds.includes('minting')) return 'mint'
  if (kinds.some((k) => GOV_KINDS.has(k))) return 'governance'
  if (kinds.some((k) => STAKING_KINDS.has(k))) return 'staking'
  return historyDirection(tx)
}

/** The dominant asset a tx moved (for the row's headline amount). */
export type PrimaryMovement = {
  /** Asset id of the headline asset; `undefined` = ADA. */
  readonly assetId: string | undefined
  /** Signed raw quantity of that asset (negative = net out). */
  readonly quantity: bigint
  /** Count of the OTHER non-zero assets moved — drives "+N more assets". */
  readonly additionalCount: number
}

/**
 * Pick the headline asset from the wallet's net movement: a non-ADA token if any
 * moved (largest absolute quantity wins), else ADA. `additionalCount` is every
 * other non-zero asset — so a NIGHT send whose ADA change returns reads as
 * "NIGHT +1 more asset", matching the reference. Direction should follow the
 * primary's sign, not the ADA flow (the row does this).
 */
export const primaryMovement = (tx: ReviewedTransaction): PrimaryMovement => {
  const nonZero = tx.ownDelta.filter((a) => a.quantity !== 0n)
  const tokens = nonZero.filter((a) => a.assetId !== undefined)
  if (tokens.length === 0) {
    const ada = nonZero.find((a) => a.assetId === undefined)
    return {assetId: undefined, quantity: ada?.quantity ?? 0n, additionalCount: 0}
  }
  const abs = (q: bigint) => (q < 0n ? -q : q)
  const primary = tokens.reduce((best, a) => (abs(a.quantity) > abs(best.quantity) ? a : best))
  return {assetId: primary.assetId, quantity: primary.quantity, additionalCount: nonZero.length - 1}
}

const startOfLocalDay = (ms: number): number => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Section-header label for a day: "Today" / "Yesterday" (via the caller's
 * strings) else a locale day+month, e.g. `17 Jul`. `nowMs` is injected for
 * determinism/testability. Also reused standalone by the home Activity widget,
 * whose rows aren't grouped under a date header.
 */
export const activityDayLabel = (
  dayMs: number,
  nowMs: number,
  locale: string,
  today: string,
  yesterday: string,
): string => {
  const day = startOfLocalDay(dayMs)
  const todayStart = startOfLocalDay(nowMs)
  const dayMsSpan = 86_400_000
  if (day === todayStart) return today
  if (day === todayStart - dayMsSpan) return yesterday
  const sameYear = new Date(day).getFullYear() === new Date(nowMs).getFullYear()
  // Day-first ("17 Jul") regardless of the locale's default order, via parts.
  const parts = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : {year: 'numeric'}),
  }).formatToParts(day)
  const val = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const base = `${val('day')} ${val('month')}`
  return sameYear ? base : `${base} ${val('year')}`
}

/**
 * Group newest-first txs into one section per local day, in order. Txs with no
 * timestamp (pending / not-yet-confirmed) collect into a leading `pending`
 * section under the caller's label.
 *
 * Generic over the payload: all it reads is `timestamp`, which is what lets one activity list carry
 * entries from more than one chain rather than each chain growing its own list and its own date headers.
 */
export const groupActivity = <T extends {readonly timestamp?: string | undefined}>(
  txs: readonly T[],
  opts: {
    readonly nowMs: number
    readonly locale: string
    readonly today: string
    readonly yesterday: string
    readonly pending: string
  },
): readonly {readonly kind: 'section'; readonly id: string; readonly label: string; readonly txs: readonly T[]}[] => {
  const out: {kind: 'section'; id: string; label: string; txs: T[]}[] = []
  let currentKey: string | null = null

  for (const tx of txs) {
    const ms = tx.timestamp !== undefined ? Date.parse(tx.timestamp) : Number.NaN
    const key = Number.isFinite(ms) ? String(startOfLocalDay(ms)) : 'pending'
    if (key !== currentKey) {
      currentKey = key
      const label =
        key === 'pending' ? opts.pending : activityDayLabel(ms, opts.nowMs, opts.locale, opts.today, opts.yesterday)
      out.push({kind: 'section', id: `s:${key}`, label, txs: [tx]})
    } else {
      out[out.length - 1]?.txs.push(tx)
    }
  }
  return out
}
