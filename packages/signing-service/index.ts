/**
 * `@pnyx/signing-service` — Effect-native signing orchestration (ports &
 * adapters). The service owns payload dispatch, witness production/coverage,
 * assembly, and broadcast sequencing; the app injects the platform seams
 * (credential vault, hardware device I/O, chain provider, UTxO context).
 *
 * Cardano is the only chain arm today; the payload union and ports are shaped
 * so future chains slot in without reworking consumers.
 *
 * @module
 */

export {type ProgressFn, signCardanoData, signCardanoTx} from './cardano.js'
export {
  type Broadcaster,
  BroadcasterTag,
  type CardanoTxContext,
  CardanoTxContextTag,
  type CredentialStore,
  CredentialStoreTag,
  type HardwareBackend,
  HardwareBackendTag,
  HardwareBackendUnavailable,
} from './ports.js'
export {type SequenceProgressFn, type SigningService, SigningServiceLayer, SigningServiceTag} from './service.js'
export {
  type CardanoDataPayload,
  type CardanoTxPayload,
  type DataSigned,
  type HardwareCredential,
  type ResolvedCredential,
  type SignerKind,
  SigningBroadcastError,
  SigningCredentialError,
  SigningDeviceError,
  type SigningError,
  type SigningPayload,
  SigningPayloadError,
  type SigningProgress,
  type SigningRequest,
  SigningSequenceError,
  type SigningSuccess,
  SigningWitnessError,
  type SoftwareCredential,
  type TxSignedOnly,
  type TxSubmitted,
} from './types.js'
export {dedupeWitnesses, missingKeyHashes, parsePath} from './witness.js'
