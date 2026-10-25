/**
 * Pure view-model for the signing-history screen: turns persisted
 * {@link SigningAuditEntry}s plus the known wallet groups into render-ready rows.
 * No React, no storage, no i18n — the screen owns every string.
 * See `docs/SIGNING_AUDIT.md`.
 *
 * @module
 */

import type {SigningAuditEntry, SigningOutcome, SigningPurpose} from '../../services/signing-audit'

/** The relative-time units the screen calls `formatRelativeTime` with. */
export type SignedAgeUnit = 'minute' | 'hour' | 'day'

/** Who the signature was on behalf of. */
export type SigningActor =
  /** A funds wallet, named. `null` name means the group is gone but the record stands. */
  | {readonly kind: 'wallet'; readonly name: string | null; readonly accountIndex: number | null}
  /** The ID slot. Not a wallet group, so it is a distinct actor rather than a nameless wallet. */
  | {readonly kind: 'identity'}

export type SigningAuditRow = {
  readonly id: string
  readonly purpose: SigningPurpose
  readonly outcome: SigningOutcome
  /** `true` for an ID-slot signature that no review screen ever showed the user. */
  readonly wasUnreviewed: boolean
  readonly actor: SigningActor
  /**
   * Requesting origin without its scheme, for display, or `null` when the user
   * started the action in-app. Always rendered as unverified — a dApp chooses it.
   */
  readonly originHost: string | null
  readonly age: {readonly value: number; readonly unit: SignedAgeUnit}
  /** How many things this ceremony signed. `1` for everything except a queued send. */
  readonly legCount: number
  /**
   * On-chain ids for the legs that landed, in order. Shorter than `legCount` when
   * legs were signed but not broadcast, which is exactly the discrepancy worth seeing.
   */
  readonly txHashes: readonly string[]
  /** A message signature carries no tx hash; the digest is the only handle on it. */
  readonly messageDigests: readonly string[]
  readonly failureReason: string | null
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** Strip the scheme (and any trailing slash) for display. */
export const displayOriginHost = (origin: string): string =>
  origin.replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '') || origin

/** Negate for the past-facing offset Intl expects, without producing `-0`. */
const past = (n: number): number => (n === 0 ? 0 : -n)

/**
 * Coarsest unit that still reads as informative, flooring — the usual elapsed-time
 * convention ("2 hours ago" while it has been 2h59m).
 *
 * No unit-promotion branch is needed here, unlike the countdown in
 * `connected-dapps-rows.ts`: flooring a span below one hour cannot reach 60 minutes,
 * so there is nothing to promote. Rounding is what makes promotion necessary there.
 */
const elapsed = (span: number): {value: number; unit: SignedAgeUnit} => {
  if (span < HOUR_MS) return {value: Math.floor(span / MINUTE_MS), unit: 'minute'}
  if (span < DAY_MS) return {value: Math.floor(span / HOUR_MS), unit: 'hour'}
  return {value: Math.floor(span / DAY_MS), unit: 'day'}
}

/** How long ago the signature happened. Clock skew (a future stamp) clamps to "now". */
export const signedAge = (at: number, now: number): {value: number; unit: SignedAgeUnit} => {
  const {value, unit} = elapsed(Math.max(0, now - at))
  return {value: past(value), unit}
}

/**
 * Build the rows, newest first.
 *
 * `walletNames` maps groupId → display name. An entry whose group is gone still
 * renders with a `null` name: the signature happened, and deleting the wallet does
 * not un-happen it. Inventing a name, or dropping the row, would both be worse.
 */
export const buildSigningAuditRows = (
  entries: readonly SigningAuditEntry[],
  walletNames: ReadonlyMap<string, string>,
  now: number,
): SigningAuditRow[] =>
  [...entries]
    .sort((a, b) => b.at - a.at)
    .map((entry) => ({
      id: entry.id,
      purpose: entry.purpose,
      outcome: entry.outcome,
      wasUnreviewed: entry.approval === 'infra-exempt',
      actor:
        entry.groupId === null
          ? ({kind: 'identity'} as const)
          : ({
              kind: 'wallet',
              name: walletNames.get(entry.groupId) ?? null,
              // An entry that named no account is shown as naming none. Displaying "account 0" for it
              // would make the audit log assert something the signature never said.
              accountIndex: entry.accountIndex,
            } as const),
      originHost: entry.origin === null ? null : displayOriginHost(entry.origin),
      age: signedAge(entry.at, now),
      legCount: entry.subjects.length,
      txHashes: entry.subjects.flatMap((s) => (s.kind === 'transaction' && s.txHash !== undefined ? [s.txHash] : [])),
      messageDigests: entry.subjects.flatMap((s) => (s.kind === 'message' ? [s.payloadDigestHex] : [])),
      failureReason: entry.failureReason ?? null,
    }))

/**
 * Split the list into what the user confirmed and what the app signed by itself.
 *
 * ### Why this is grouped rather than counted
 *
 * The first version led with "treat this wallet as compromised" and then stated how
 * many signatures never showed a review screen. Read together — and every routine
 * launch produces two or three of those — it presented **working-as-intended
 * behaviour as evidence of compromise**. A surface that cries wolf gets ignored,
 * which destroys exactly the detection value it exists for.
 *
 * So the exemption stays *visible* (item 45 asks for visible, not alarming) but is
 * shown as its own explained section rather than an alarming aggregate. The genuine
 * signal is then scoped to where an anomaly would actually appear: a transaction in
 * the confirmed section that the user does not remember confirming.
 *
 * Either group may be empty and an empty one must not render — same rule as the
 * review screen's party tiers.
 */
export const groupSigningAuditRows = (
  rows: readonly SigningAuditRow[],
): {readonly confirmed: readonly SigningAuditRow[]; readonly automatic: readonly SigningAuditRow[]} => ({
  confirmed: rows.filter((row) => !row.wasUnreviewed),
  automatic: rows.filter((row) => row.wasUnreviewed),
})

/** How much of a failure reason a row shows before the copy button becomes the way to read the rest. */
const FAILURE_SUMMARY_LIMIT = 140

/**
 * A submit failure, cut down to something a row can carry.
 *
 * Node and ledger rejections arrive as multi-line JSON hundreds of characters long. Rendered whole
 * they push every other field — who signed, for which site, how long ago — off the screen, so the one
 * surface that exists to make an unexplained signature visible becomes the hardest place to read one.
 *
 * ⚠️ Nothing is lost: the screen copies the **full** reason, not this. Truncating what is copied would
 * make the detail unusable for the report it exists to support.
 */
export const summariseFailureReason = (reason: string, limit: number = FAILURE_SUMMARY_LIMIT): string => {
  const collapsed = reason.replace(/\s+/g, ' ').trim()
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit).trimEnd()}…`
}
