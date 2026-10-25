/**
 * Signing audit log — the detection half of Phase 16 item 45 and item 39's
 * auditability requirement. Behaviour contract: `docs/SIGNING_AUDIT.md`.
 *
 * @module
 */

export {
  appendEntry,
  auditEntryId,
  buildCeremonyEntry,
  buildInfraEntry,
  digestOfHex,
  MAX_AUDIT_ENTRIES,
  messageSubjectOf,
  outcomeOf,
  subjectsOf,
} from './record'
export {
  clearSigningAudit,
  listSigningAudit,
  parseAuditEntry,
  recordInfraSignature,
  recordSigningAudit,
  SIGNING_AUDIT_KEY,
} from './store'
export {
  type ApprovalKind,
  approvalOfPurpose,
  isFundsPurpose,
  type SignerRefKind,
  type SigningAuditContext,
  type SigningAuditEntry,
  type SigningMessageSubject,
  type SigningOutcome,
  type SigningPurpose,
  type SigningSubject,
  type SigningTransactionSubject,
} from './types'
