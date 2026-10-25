/** Portable partial-signature transport (envelope + registry + orchestration). @module */
export {
  addSignature,
  assembleEnvelope,
  constructEnvelope,
  EnvelopeError,
  keyIndexesOf,
  networkOfChainId,
  parseEnvelope,
  type RosterEntry,
  requiredFor,
  rosterByCoSigner,
  scriptIndexOf,
  scriptRoleAt,
  serializeEnvelope,
  statusOf,
} from './envelope'
export {envelopeWitnessesFrom, partialSignRequest, signIntoEnvelope, submitEnvelope} from './orchestrate'
export {persistCosign, platformForgetCosign, platformPersistCosign, stableCosignId} from './persist'
export {
  getCosign,
  listCosigns,
  type PendingCosign,
  platformCosignRegistry,
  removeCosign,
  saveCosign,
} from './registry'
export type {EnvelopeKind, EnvelopeSigner, EnvelopeWitness, SignatureStatus, TxEnvelope} from './types'
