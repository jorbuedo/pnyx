/**
 * cNIGHT → DUST: the Cardano-side registration that makes NIGHT generate the DUST which
 * pays Midnight fees.
 *
 * Read-only for now — it reports registration health and explains every way DUST can fail
 * to appear. Registering, changing the destination and repairing a double registration come
 * next; see roadmap item 50.
 *
 * @module
 */

export {
  buildDestinationChangeTxs,
  buildRegistrationTx,
  DustBuildError,
  type RegistrationIntent,
} from './midnight-dust/build-registration'
export {
  type DestinationChoice,
  type DestinationOwner,
  describeDestination,
  dustAddressFromPayload,
  pnyxDustAddress,
} from './midnight-dust/destination'
export {fetchDustGenerationStatus, snapshotFromBody} from './midnight-dust/indexer'
export {
  DUST_DECIMALS,
  type DustGeneration,
  type DustGenerationRow,
  type DustGenerationSnapshot,
  NIGHT_DECIMALS,
  parseDustGeneration,
  toObservedDust,
} from './midnight-dust/observability'
export {
  type DecodedDustRegistrationDatum,
  decodeDustRegistrationDatum,
  encodeDustRegistrationDatum,
} from './midnight-dust/registration-datum'
export {
  type AssessRegistrationInput,
  assessRegistration,
  type CnightUtxo,
  type DustAddrPayload,
  type NoGenCause,
  type ObservedDust,
  type RegistrationAction,
  type RegistrationAssessment,
  type RegistrationState,
  type RegistrationUtxo,
  type StakeKeyHash,
  type TxIn,
} from './midnight-dust/registration-health'
export {
  activeRegistrations,
  carriesDustAuthToken,
  DUST_MAPPING_POLICY_ID,
  isDustAuthToken,
  isDustRegistrationTx,
  type ScanIO,
  type ScanToken,
  type ScanTx,
} from './midnight-dust/registration-scan'
