/**
 * Persistence for the signing audit log: an append-only, capped, newest-first
 * list in platform storage.
 *
 * ### Best-effort by design
 *
 * Every write is swallowed and logged. This runs on the settle path of a signature
 * that has *already* been produced — often already broadcast — so a storage
 * failure must never turn a successful send into a failed one. That is a real
 * limitation and it is the honest one: the log can under-report, and it can never
 * cause the thing it is recording to fail.
 *
 * ### Validated, not cast
 *
 * `load` shape-checks every row and drops the ones that fail. Rows arrive from
 * ordinary storage and feed a security surface, so a row we cannot vouch for is
 * worse than a missing row — a half-parsed entry would render as a signature with
 * invented properties.
 *
 * @module
 */

import type {SigningRequest, SigningSuccess} from '@pnyx/signing-service'
import {logger} from '../../logger'
import {storage} from '../../platform/storage'
import {appendEntry, buildCeremonyEntry, buildInfraEntry, MAX_AUDIT_ENTRIES, messageSubjectOf} from './record'
import {
  type ApprovalKind,
  approvalOfPurpose,
  type SignerRefKind,
  type SigningAuditContext,
  type SigningAuditEntry,
  type SigningOutcome,
  type SigningPurpose,
  type SigningSubject,
} from './types'

export const SIGNING_AUDIT_KEY = '@pnyx/signing/audit'

/**
 * Runtime members of each union, keyed by the union itself so a missing one is a **compile** error.
 *
 * Written as `Record<T, true>` rather than an array for a reason paid for once already: a hand-kept
 * `SignerRefKind[]` omitted `'pnyx-id'`, and since these guards decide what `parseEntry` accepts,
 * every login signature was dropped on read — an audit log quietly missing entries, which is worse
 * than one that fails. `Object.keys` of a total record cannot drift from the type.
 */
const membersOf = <T extends string>(record: Record<T, true>): readonly T[] => Object.keys(record) as T[]

const PURPOSES = membersOf<SigningPurpose>({
  send: true,
  stake: true,
  swap: true,
  consolidate: true,
  dust: true,
  cosign: true,
  'dapp-tx': true,
  'dapp-message': true,
  'air-gap': true,
  'koios-register': true,
  'steelswap-register': true,
  'identity-login': true,
  'device-push-binding': true,
  'bug-report': true,
  'circle-invite-request': true,
})

const OUTCOMES = membersOf<SigningOutcome>({submitted: true, signed: true, failed: true})
const APPROVALS = membersOf<ApprovalKind>({reviewed: true, 'infra-exempt': true})

const isPurpose = (v: unknown): v is SigningPurpose => PURPOSES.includes(v as SigningPurpose)
const isOutcome = (v: unknown): v is SigningOutcome => OUTCOMES.includes(v as SigningOutcome)
const isApproval = (v: unknown): v is ApprovalKind => APPROVALS.includes(v as ApprovalKind)

const SIGNER_KINDS = membersOf<SignerRefKind>({
  'pnyx-id': true,
  'cardano-address-hex': true,
  'mn-addr': true,
  'verifying-key-hex': true,
})
const isSignerRefKind = (v: unknown): v is SignerRefKind => SIGNER_KINDS.includes(v as SignerRefKind)

const parseSubject = (value: unknown): SigningSubject | null => {
  if (typeof value !== 'object' || value === null) return null
  const s = value as Record<string, unknown>
  if (s.kind === 'message') {
    if (
      typeof s.payloadDigestHex !== 'string' ||
      typeof s.payloadByteLength !== 'number' ||
      typeof s.signer !== 'string' ||
      !isSignerRefKind(s.signerKind)
    ) {
      return null
    }
    return {
      kind: 'message',
      payloadDigestHex: s.payloadDigestHex,
      payloadByteLength: s.payloadByteLength,
      signer: s.signer,
      signerKind: s.signerKind,
    }
  }
  if (s.kind !== 'transaction') return null
  if (typeof s.bodyDigestHex !== 'string' || typeof s.signOnly !== 'boolean') return null
  return {
    kind: 'transaction',
    ...(typeof s.txHash === 'string' ? {txHash: s.txHash} : {}),
    bodyDigestHex: s.bodyDigestHex,
    signOnly: s.signOnly,
  }
}

/**
 * Validate one persisted row.
 *
 * `approval` is **recomputed from the purpose** rather than read back. It is a
 * derived property, so trusting the stored copy would let a tampered row claim a
 * funds signature was infrastructure — the one classification a reader most needs
 * to be true.
 */
export const parseAuditEntry = (value: unknown): SigningAuditEntry | null => {
  if (typeof value !== 'object' || value === null) return null
  const e = value as Record<string, unknown>
  if (typeof e.id !== 'string' || typeof e.at !== 'number') return null
  if (!isPurpose(e.purpose) || !isOutcome(e.outcome)) return null
  if (e.approval !== undefined && !isApproval(e.approval)) return null
  if (!Array.isArray(e.subjects)) return null
  const subjects = e.subjects.map(parseSubject)
  if (subjects.some((s) => s === null)) return null
  return {
    id: e.id,
    at: e.at,
    purpose: e.purpose,
    approval: approvalOfPurpose(e.purpose),
    outcome: e.outcome,
    origin: typeof e.origin === 'string' ? e.origin : null,
    groupId: typeof e.groupId === 'string' ? e.groupId : null,
    accountIndex: typeof e.accountIndex === 'number' ? e.accountIndex : null,
    subjects: subjects as readonly SigningSubject[],
    ...(typeof e.failureReason === 'string' ? {failureReason: e.failureReason} : {}),
  }
}

/** Read the log, newest first, dropping unparseable rows. */
export const listSigningAudit = async (): Promise<readonly SigningAuditEntry[]> => {
  try {
    const json = await storage.get(SIGNING_AUDIT_KEY)
    if (!json) return []
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(parseAuditEntry)
      .filter((e): e is SigningAuditEntry => e !== null)
      .slice(0, MAX_AUDIT_ENTRIES)
  } catch (e) {
    logger.warn('Failed to load signing audit log', {origin: 'SigningAudit', error: String(e)})
    return []
  }
}

/** Erase the log. Called from the full-reset path, never on lock. */
export const clearSigningAudit = async (): Promise<void> => {
  try {
    await storage.remove(SIGNING_AUDIT_KEY)
  } catch (e) {
    logger.warn('Failed to clear signing audit log', {origin: 'SigningAudit', error: String(e)})
  }
}

let seq = 0

/** Persist one built entry. Shared tail of both recorders; never throws. */
const persist = async (entry: SigningAuditEntry, purpose: SigningPurpose): Promise<void> => {
  try {
    const next = appendEntry(await listSigningAudit(), entry)
    await storage.set(SIGNING_AUDIT_KEY, JSON.stringify(next))
  } catch (e) {
    logger.warn('Failed to record signing audit entry', {origin: 'SigningAudit', purpose, error: String(e)})
  }
}

export type RecordSigningParams = {
  readonly context: SigningAuditContext
  readonly requests: readonly SigningRequest[]
  readonly results: readonly SigningSuccess[]
  readonly failureReason?: string
}

/**
 * Append one settled ceremony to the log.
 *
 * Never throws and never rejects: the caller is a settle path on a signature that
 * already happened. A failure to record is logged as a warning, which is the only
 * escalation available without risking the transaction itself.
 */
export const recordSigningAudit = async (params: RecordSigningParams): Promise<void> => {
  seq += 1
  const entry = buildCeremonyEntry({
    context: params.context,
    requests: params.requests,
    results: params.results,
    at: Date.now(),
    seq,
    ...(params.failureReason === undefined ? {} : {failureReason: params.failureReason}),
  })
  await persist(entry, params.context.purpose)
}

/**
 * Record an ID-slot signature that never passes through the ceremony rail.
 *
 * The CIP-8 and BIP-340 infra paths hold their own derived key and call the
 * primitive directly (Phase 16 item 41's finding), so there is no `SigningRequest`
 * to derive a subject from. The caller passes the payload it signed and the address
 * that signed it, and nothing else is inferred — in particular no wallet group and
 * no network are invented for a signature that has neither.
 */
export const recordInfraSignature = async (params: {
  readonly purpose: SigningPurpose
  readonly payloadHex: string
  readonly signer: string
  readonly signerKind: SignerRefKind
  readonly origin?: string | null
  readonly failureReason?: string
}): Promise<void> => {
  seq += 1
  const entry = buildInfraEntry({
    context: {purpose: params.purpose, origin: params.origin ?? null},
    subject: messageSubjectOf(params.payloadHex, params.signer, params.signerKind),
    at: Date.now(),
    seq,
    ...(params.failureReason === undefined ? {} : {failureReason: params.failureReason}),
  })
  await persist(entry, params.purpose)
}
