/** Persisted multi-leg signing continuations (record model + storage). @module */

export {
  type ContinuationReconciliation,
  type LegState,
  type ReconcileVerdict,
  reconcileContinuation,
  reconcileVerdict,
} from './reconcile'
export {
  appendSignedStep as appendSignedStepPure,
  CONTINUATION_SCHEMA_VERSION,
  type ContinuationRecord,
  type ContinuationStatus,
  type CreateContinuationParams,
  createContinuation,
  hasResumablePayload,
  isResumable,
  markBroadcasting,
  markError,
  type SignedStep,
  storedRequests,
} from './record'
export {
  appendSignedStep,
  getContinuation,
  listContinuations,
  platformContinuationStore,
  removeContinuation,
  saveContinuation,
} from './store'
