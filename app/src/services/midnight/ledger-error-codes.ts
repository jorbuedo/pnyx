/**
 * What a node's `Custom error: N` actually names.
 *
 * The node answers every ledger rejection with the same `1010 Invalid Transaction` and puts a bare
 * number in `data`. The number is not a ledger enum discriminant — it is a **hand-written table** in
 * midnight-node's `ledger/src/versions/common/types.rs` (`impl From<LedgerApiError> for u8`), which is
 * why no arithmetic over the ledger crate's variant order reproduces it: `InvalidNetworkId` is variant
 * 0 but code 166, and `FeeCalculation` is variant 19 but code 168.
 *
 * Transcribed from tag `node-1.0.2-alpha.3`, matching the `1.0.2-eb71e64e` that preprod's
 * `system_version` reports. Two of the codes here were verified against the live chain by submitting
 * transactions whose verdict was known in advance — see
 * `packages/midnight-native/rust/tests/dust_registration_error_codes.rs`.
 *
 * ⚠️ **Codes are retired and reused across node releases.** A name is only as good as the runtime that
 * produced it, so {@link describeLedgerErrorCode} labels rather than promises, and the raw number is
 * always kept alongside it.
 *
 * @module
 */

/** Code → the `LedgerApiError` variant midnight-node maps it from. */
const LEDGER_ERROR_CODES: Readonly<Record<number, string>> = {
  0: 'NetworkId',
  1: 'Transaction',
  2: 'DeserializationLedgerState',
  3: 'DeserializationContractAddress',
  4: 'PublicKey',
  5: 'Deserialization::VersionedArenaKey',
  6: 'Deserialization::UserAddress',
  7: 'Deserialization::TypedArenaKey',
  8: 'Deserialization::SystemTransaction',
  9: 'Deserialization::DustPublicKey',
  10: 'Deserialization::CNightGeneratesDustActionType',
  11: 'Deserialization::CNightGeneratesDustEvent',
  50: 'TransactionIdentifier',
  51: 'SerializationLedgerState',
  52: 'LedgerParameters',
  53: 'SerializationContractAddress',
  54: 'ContractState',
  55: 'ContractStateToJson',
  56: 'ZswapState',
  57: 'UnknownType',
  58: 'MerkleTreeDigest',
  59: 'Serialization::VersionedArenaKey',
  60: 'Serialization::TypedArenaKey',
  61: 'Serialization::CNightGeneratesDustEvent',
  62: 'Serialization::SystemTransaction',
  63: 'Serialization::ArenaHash',
  100: 'Invalid::EffectsMismatch',
  101: 'Invalid::ContractAlreadyDeployed',
  102: 'Invalid::ContractNotPresent',
  103: 'Invalid::Zswap',
  104: 'Invalid::Transcript',
  105: 'Invalid::InsufficientClaimable',
  106: 'Invalid::VerifierKeyNotFound',
  107: 'Invalid::VerifierKeyAlreadyPresent',
  108: 'Invalid::ReplayCounterMismatch',
  109: 'Invalid::UnknownError',
  110: 'Malformed::VerifierKeyNotSet',
  111: 'Malformed::TransactionTooLarge',
  112: 'Malformed::VerifierKeyTooLarge',
  113: 'Malformed::VerifierKeyNotPresent',
  114: 'Malformed::ContractNotPresent',
  115: 'Malformed::InvalidProof',
  116: 'Malformed::BindingCommitmentOpeningInvalid',
  117: 'Malformed::NotNormalized',
  118: 'Malformed::FallibleWithoutCheckpoint',
  119: 'Malformed::ClaimReceiveFailed',
  120: 'Malformed::ClaimSpendFailed',
  121: 'Malformed::ClaimNullifierFailed',
  122: 'Malformed::ClaimCallFailed',
  123: 'Malformed::InvalidSchnorrProof',
  124: 'Malformed::UnclaimedCoinCom',
  125: 'Malformed::UnclaimedNullifier',
  126: 'Malformed::Unbalanced',
  127: 'Malformed::Zswap',
  128: 'Malformed::BuiltinDecode',
  129: 'Malformed::GuaranteedLimit',
  130: 'Malformed::MergingContracts',
  131: 'Malformed::CantMergeTypes',
  132: 'Malformed::ClaimOverflow',
  133: 'Malformed::ClaimCoinMismatch',
  134: 'Malformed::KeyNotInCommittee',
  135: 'Malformed::InvalidCommitteeSignature',
  136: 'Malformed::ThresholdMissed',
  137: 'Malformed::TooManyZswapEntries',
  138: 'Malformed::BalanceCheckOverspend',
  139: 'Malformed::UnknownError',
  150: 'LedgerCacheError',
  151: 'NoLedgerState',
  152: 'LedgerStateScaleDecodingError',
  153: 'ContractCallCostError',
  154: 'BlockLimitExceededError',
  155: 'FeeCalculationError',
  165: 'GetTransactionContextError',
  166: 'Malformed::InvalidNetworkId',
  167: 'Malformed::IllegallyDeclaredGuaranteed',
  168: 'Malformed::FeeCalculation',
  169: 'Malformed::InvalidDustRegistrationSignature',
  170: 'Malformed::InvalidDustSpendProof',
  171: 'Malformed::OutOfDustValidityWindow',
  172: 'Malformed::MultipleDustRegistrationsForKey',
  173: 'Malformed::InsufficientDustForRegistrationFee',
  174: 'Malformed::MalformedContractDeploy',
  175: 'Malformed::IntentSignatureVerificationFailure',
  176: 'Malformed::IntentSignatureKeyMismatch',
  177: 'Malformed::IntentSegmentIdCollision',
  178: 'Malformed::IntentAtGuaranteedSegmentId',
  179: 'Malformed::UnsupportedProofVersion',
  180: 'Malformed::GuaranteedTranscriptVersion',
  181: 'Malformed::FallibleTranscriptVersion',
  182: 'Malformed::TransactionApplicationError',
  183: 'Malformed::BalanceCheckOutOfBounds',
  184: 'Malformed::BalanceCheckConversionFailure',
  185: 'Malformed::PedersenCheckFailure',
  186: 'Malformed::EffectsCheckFailure',
  187: 'Malformed::DisjointCheckFailure',
  188: 'Malformed::SequencingCheckFailure',
  189: 'Malformed::InputsNotSorted',
  190: 'Malformed::OutputsNotSorted',
  191: 'Malformed::DuplicateInputs',
  192: 'Malformed::InputsSignaturesLengthMismatch',
  193: 'Invalid::ReplayProtectionViolation',
  194: 'Invalid::BalanceCheckOutOfBounds',
  195: 'Invalid::InputNotInUtxos',
  196: 'Invalid::DustDoubleSpend',
  197: 'Invalid::DustDeregistrationNotRegistered',
  198: 'Invalid::GenerationInfoAlreadyPresent',
  199: 'Invalid::InvariantViolation',
  200: 'Invalid::RewardTooSmall',
  201: 'SystemTransaction::IllegalPayout',
  202: 'SystemTransaction::InsufficientTreasuryFunds',
  203: 'SystemTransaction::CommitmentAlreadyPresent',
  204: 'SystemTransaction::UnknownError',
  205: 'SystemTransaction::ReplayProtectionFailure',
  206: 'SystemTransaction::IllegalReserveDistribution',
  207: 'SystemTransaction::GenerationInfoAlreadyPresent',
  208: 'SystemTransaction::InvalidBasisPoints',
  209: 'SystemTransaction::InvariantViolation',
  210: 'SystemTransaction::TreasuryDisabled',
  211: 'SystemTransaction::MerkleTreeError',
  255: 'HostApiError',
}

/**
 * The variant `code` names, or `null` when this build's table has no entry.
 *
 * `null` rather than "unknown error": a code we cannot name is a different fact from a code the node
 * itself calls unknown (109, 139, 204), and collapsing them would hide a runtime upgrade.
 */
export const describeLedgerErrorCode = (code: number): string | null => LEDGER_ERROR_CODES[code] ?? null

/** Matches the node's `Custom error: N`, the only place the reason for a rejection appears. */
const CUSTOM_ERROR = /Custom error: (\d+)/

/**
 * Name the ledger error inside a node rejection, leaving the message otherwise intact.
 *
 * Appends rather than replaces. The raw code is what a bug report and a search of midnight-node's
 * table both need, so it stays; the name is what makes the line readable without either.
 */
export const nameLedgerRejection = (message: string): string => {
  const found = CUSTOM_ERROR.exec(message)
  if (found?.[1] === undefined) return message
  const named = describeLedgerErrorCode(Number(found[1]))
  return named === null ? message : `${message} — ${named}`
}
