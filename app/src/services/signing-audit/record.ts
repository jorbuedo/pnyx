/**
 * Pure construction and reduction of {@link SigningAuditEntry} values. No
 * storage, no React, no clock — `at` and `seq` are arguments so every shape here
 * is directly testable.
 *
 * The derivation rule that matters: {@link subjectsOf} builds the subjects from
 * the `SigningRequest`s that were actually handed to the signer and the
 * `SigningSuccess`es that came back. A producer supplies neither, so it cannot
 * misdescribe what it signed.
 *
 * @module
 */

import {hex, sha256} from '@pnyx/crypto'
import type {SigningRequest, SigningSuccess} from '@pnyx/signing-service'
import {Either} from 'effect'
import {
  approvalOfPurpose,
  isFundsPurpose,
  type SignerRefKind,
  type SigningAuditContext,
  type SigningAuditEntry,
  type SigningOutcome,
  type SigningSubject,
} from './types'

/** How many entries the store keeps in total. */
export const MAX_AUDIT_ENTRIES = 300

/**
 * Sub-cap on `infra-exempt` entries.
 *
 * Every launch signs a forum sign-in plus a chain/price data access, so without a
 * separate ceiling the automatic kind grows at a few per launch and the store becomes
 * almost entirely sign-ins — the funds entries survive eviction (see
 * {@link appendEntry}) but sit under hundreds of near-identical rows, which buries the
 * signal just as effectively as dropping it.
 *
 * The trade-off, stated rather than hidden: a smaller number here makes ID-slot history
 * cheaper for an attacker to flush by generating fresh infra signatures. 100 keeps weeks
 * of ordinary use while leaving the majority of the store for funds signatures, which are
 * the ones a compromise of value shows up in.
 */
export const MAX_AUTOMATIC_ENTRIES = 100

/**
 * SHA-256 of hex-encoded bytes, itself hex.
 *
 * Malformed hex yields the empty string rather than a thrown error or a digest of
 * the literal text: this runs on the settle path of a signature that already
 * happened, so it must never be able to fail the ceremony, and a digest of
 * something other than the bytes would be a false record. An empty digest reads as
 * "not computable" at the surface.
 */
export const digestOfHex = (value: string): string => {
  const decoded = hex.decode(value)
  return Either.isRight(decoded) ? hex.encode(sha256(decoded.right)) : ''
}

/** Byte length of hex-encoded data; `0` when it is not valid hex. */
const byteLengthOfHex = (value: string): number => {
  const decoded = hex.decode(value)
  return Either.isRight(decoded) ? decoded.right.length : 0
}

/**
 * The message subject for a payload signed outside the ceremony rail (CIP-8 /
 * BIP-340 over the ID slot). Digesting happens here so no call site handles the
 * bytes a second time.
 */
export const messageSubjectOf = (payloadHex: string, signer: string, signerKind: SignerRefKind): SigningSubject => ({
  kind: 'message',
  payloadDigestHex: digestOfHex(payloadHex),
  payloadByteLength: byteLengthOfHex(payloadHex),
  signer,
  signerKind,
})

/**
 * One subject per request, enriched with whatever the matching result proved.
 *
 * Results are positional — `signAll` runs legs strictly in order and stops on
 * failure — so a failed ceremony has fewer results than requests and the trailing
 * legs simply carry no hash. They are still recorded: a leg that was signed but
 * whose submit failed is exactly the kind of thing an audit surface exists to show.
 */
export const subjectsOf = (
  requests: readonly SigningRequest[],
  results: readonly SigningSuccess[],
): readonly SigningSubject[] =>
  requests.map((request, index) => {
    const result = results[index]
    if (request.payload._tag === 'CardanoData') {
      // A ceremony-rail `signData` is always Cardano CIP-8, so the signer is a raw address.
      return {
        kind: 'message' as const,
        payloadDigestHex: digestOfHex(request.payload.payloadHex),
        payloadByteLength: byteLengthOfHex(request.payload.payloadHex),
        signer: request.payload.addressHex,
        signerKind: 'cardano-address-hex' as const,
      }
    }
    const {bodyHex, signOnly} = request.payload
    return {
      kind: 'transaction' as const,
      ...(result?._tag === 'TxSubmitted' ? {txHash: result.txHash} : {}),
      bodyDigestHex: digestOfHex(bodyHex),
      signOnly: signOnly === true,
    }
  })

/**
 * The outcome of a settled ceremony.
 *
 * `submitted` requires *every* leg to have landed on chain — a chain where leg 2
 * failed is not "submitted", and calling it that is precisely the misreport this
 * surface is meant to prevent. A ceremony that produced no result at all failed.
 */
export const outcomeOf = (requests: readonly SigningRequest[], results: readonly SigningSuccess[]): SigningOutcome => {
  if (results.length === 0) return 'failed'
  if (results.length < requests.length) return 'failed'
  return results.every((r) => r._tag === 'TxSubmitted') ? 'submitted' : 'signed'
}

/** Entry id: settle time plus a per-process sequence, so same-millisecond entries stay distinct. */
export const auditEntryId = (at: number, seq: number): string => `${at.toString(36)}-${seq.toString(36)}`

export type BuildCeremonyEntryParams = {
  readonly context: SigningAuditContext
  readonly requests: readonly SigningRequest[]
  readonly results: readonly SigningSuccess[]
  readonly at: number
  readonly seq: number
  /** Set when the ceremony threw; forces `outcome: 'failed'`. */
  readonly failureReason?: string
}

/**
 * Build the entry for one settled ceremony on the signing-service rail.
 *
 * `groupId` / `accountIndex` come from the first request rather than from the
 * caller. For an ID-slot purpose they are recorded as `null`: the identity is not
 * a wallet group, and writing the group of whatever request happened to be present
 * would attribute an ID signature to a funds wallet.
 */
export const buildCeremonyEntry = (params: BuildCeremonyEntryParams): SigningAuditEntry => {
  const {context, requests, results, at, seq, failureReason} = params
  const funds = isFundsPurpose(context.purpose)
  const first = requests[0]
  return {
    id: auditEntryId(at, seq),
    at,
    purpose: context.purpose,
    approval: approvalOfPurpose(context.purpose),
    outcome: failureReason === undefined ? outcomeOf(requests, results) : 'failed',
    origin: context.origin,
    groupId: funds ? (first?.groupId ?? null) : null,
    // `null`, not `0`: the field is nullable precisely because a request may not name an account, and
    // recording account 0 for one that named none writes a fact into an audit trail that never happened.
    accountIndex: funds ? (first?.accountIndex ?? null) : null,
    subjects: subjectsOf(requests, results),
    ...(failureReason === undefined ? {} : {failureReason}),
  }
}

export type BuildInfraEntryParams = {
  readonly context: SigningAuditContext
  /** What was signed. Built by {@link messageSubjectOf} from the payload the caller signed. */
  readonly subject: SigningSubject
  readonly at: number
  readonly seq: number
  readonly failureReason?: string
}

/**
 * Build the entry for an ID-slot signature produced off the ceremony rail.
 *
 * These paths hold their own derived key and call `Cose.signData` / `signSiwm`
 * directly (Phase 16 item 41's finding), so there is no `SigningRequest` to derive
 * a subject from and none is invented: the caller passes the subject it built from
 * the bytes it signed. `groupId` / `accountIndex` stay `null` — the ID slot is not
 * a wallet group and has no CIP-1852 account in this sense.
 */
export const buildInfraEntry = (params: BuildInfraEntryParams): SigningAuditEntry => {
  const {context, subject, at, seq, failureReason} = params
  return {
    id: auditEntryId(at, seq),
    at,
    purpose: context.purpose,
    approval: approvalOfPurpose(context.purpose),
    outcome: failureReason === undefined ? 'signed' : 'failed',
    origin: context.origin,
    groupId: null,
    accountIndex: null,
    subjects: [subject],
    ...(failureReason === undefined ? {} : {failureReason}),
  }
}

/**
 * Append one entry, newest first, capped at {@link MAX_AUDIT_ENTRIES}.
 *
 * Nothing is deduplicated: two identical signatures are two events, and collapsing
 * them would hide a replay — the exact thing a reader of this log is looking for.
 *
 * ### Eviction drops infrastructure first, and that is the important part
 *
 * A flat "drop the oldest" cap is wrong here. Every app launch produces an ID-slot
 * signature or two (forum sign-in, chain/price data access) — five accumulated in
 * fourteen minutes of ordinary use while this was being driven on device — so under a
 * shared cap that routine chatter would steadily evict the **funds** signatures, which
 * are the only ones a compromise would show up in. The log would quietly become a list
 * of sign-ins.
 *
 * So the oldest `infra-exempt` entries go first, and a `reviewed` entry is only dropped
 * once the reviewed set alone exceeds the cap. Both orderings stay newest-first.
 */
export const appendEntry = (
  entries: readonly SigningAuditEntry[],
  entry: SigningAuditEntry,
  max: number = MAX_AUDIT_ENTRIES,
  maxAutomatic: number = MAX_AUTOMATIC_ENTRIES,
): readonly SigningAuditEntry[] => {
  // The one ordering invariant: **sorted by `at`, newest first** — asserted here rather
  // than assumed from insertion order. Mixing the two silently dropped a middle entry
  // (keeping 4,3,1 of 5..1) because `slice` trusted position while eviction trusted `at`.
  // In production the two agree, since `at` is the clock; the moment they don't, one of
  // them has to win, and for an audit log it must be the timestamp.
  const all = [entry, ...entries].sort((a, b) => b.at - a.at)
  const infraCount = all.reduce((n, e) => (e.approval === 'infra-exempt' ? n + 1 : n), 0)
  if (all.length <= max && infraCount <= maxAutomatic) return all

  const keptReviewed = all.filter((e) => e.approval === 'reviewed').slice(0, max)
  const keptInfra = all
    .filter((e) => e.approval === 'infra-exempt')
    .slice(0, Math.min(maxAutomatic, max - keptReviewed.length))
  return [...keptReviewed, ...keptInfra].sort((a, b) => b.at - a.at)
}
