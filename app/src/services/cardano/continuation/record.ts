/**
 * Pure model for a multi-step signing continuation: the durable record of a
 * multi-leg flow (signAll / tx-chaining / co-sign resume) that must survive
 * process death. No storage, no React — the store persists these and the
 * signing rail advances them one broadcast at a time.
 *
 * `status` evolves as legs complete: `awaiting-user` → `broadcasting` (a leg is
 * being submitted) → `signed` (≥1 leg landed, more remain) → `completed` (all
 * legs landed). `error` is terminal for a failed leg and carries the reason.
 *
 * @module
 */

export const CONTINUATION_SCHEMA_VERSION = 1

export type ContinuationStatus = 'awaiting-user' | 'broadcasting' | 'signed' | 'error' | 'completed'

/** One broadcast leg: a stable step id and the resulting on-chain tx hash. */
export type SignedStep = {
  readonly stepId: string
  readonly txHash: string
}

export type ContinuationRecord = {
  readonly schemaVersion: number
  /** Human/label context for the flow, e.g. `'cardano.signAll'`. */
  readonly context: string
  readonly groupId: string
  readonly continuationId: string
  readonly status: ContinuationStatus
  readonly signedSteps: readonly SignedStep[]
  readonly expectedStepCount: number
  /** Count of legs settled so far (== signedSteps.length). */
  readonly currentStepIndex: number
  /** Route to return the user to when resuming, if any. */
  readonly returnTo?: string
  /** Failure reason when `status === 'error'`. */
  readonly error?: string
  /** Opaque per-flow context carried across restarts. */
  readonly contextData?: Record<string, unknown>
}

export type CreateContinuationParams = {
  readonly groupId: string
  readonly continuationId: string
  readonly context: string
  readonly expectedStepCount: number
  readonly returnTo?: string
  readonly contextData?: Record<string, unknown>
}

/** A fresh continuation awaiting the user's first authentication. */
export const createContinuation = (params: CreateContinuationParams): ContinuationRecord => ({
  schemaVersion: CONTINUATION_SCHEMA_VERSION,
  context: params.context,
  groupId: params.groupId,
  continuationId: params.continuationId,
  status: 'awaiting-user',
  signedSteps: [],
  expectedStepCount: params.expectedStepCount,
  currentStepIndex: 0,
  ...(params.returnTo !== undefined ? {returnTo: params.returnTo} : {}),
  ...(params.contextData !== undefined ? {contextData: params.contextData} : {}),
})

/** Mark the record as actively broadcasting a leg (no step landed yet). */
export const markBroadcasting = (record: ContinuationRecord): ContinuationRecord =>
  record.status === 'completed' || record.status === 'error' ? record : {...record, status: 'broadcasting'}

const statusForStepCount = (settled: number, expected: number): ContinuationStatus =>
  settled >= expected ? 'completed' : 'signed'

/**
 * Record a landed leg: append the step, advance `currentStepIndex`, recompute
 * `status`. Idempotent on `stepId` — re-appending a step already present
 * returns the record unchanged (safe under retry / resume).
 */
export const appendSignedStep = (record: ContinuationRecord, step: SignedStep): ContinuationRecord => {
  if (record.signedSteps.some((s) => s.stepId === step.stepId)) return record
  const signedSteps = [...record.signedSteps, step]
  return {
    ...record,
    signedSteps,
    currentStepIndex: signedSteps.length,
    status: statusForStepCount(signedSteps.length, record.expectedStepCount),
  }
}

/** Terminal failure: record the reason and freeze progress. */
export const markError = (record: ContinuationRecord, error: string): ContinuationRecord => ({
  ...record,
  status: 'error',
  error,
})

/** True when the flow has more legs to broadcast (resumable). */
export const isResumable = (record: ContinuationRecord): boolean =>
  record.status !== 'completed' && record.signedSteps.length < record.expectedStepCount

/**
 * True when the record carries a reconstructable multi-leg payload (the
 * `requests` array stashed in `contextData`) with legs still to broadcast, so
 * the resume rail can rebuild the remaining requests. Pure — never fabricates.
 */
export const hasResumablePayload = (record: ContinuationRecord): boolean => {
  const stashed = record.contextData?.requests
  return Array.isArray(stashed) && stashed.length > record.currentStepIndex
}

/**
 * Every leg the record stashed, in submission order — `null` when it carries none.
 *
 * Unlike the resume path, which slices from `currentStepIndex`, this is the whole ceremony:
 * reconciling against the chain has to ask about the legs the record *claims* are done too,
 * because that claim is exactly what can be wrong.
 */
export const storedRequests = (record: ContinuationRecord): readonly unknown[] | null => {
  const stashed = record.contextData?.requests
  return Array.isArray(stashed) ? stashed : null
}
