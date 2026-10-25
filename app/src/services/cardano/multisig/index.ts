/** CIP-1854 shared (multisig) wallets: templates, seedless derivation, model, storage. @module */

export {cardanoAccountFromSharedWallet, ownStakeKeyHash} from './account'
export {
  buildCoSignerLink,
  type InviteParseError,
  readCoSignerKey,
} from './cosigner-invite'
export {coSignerFailureKey, failureNeedsDevice} from './cosigner-key-message'
export {
  addressesUpTo,
  compileTemplate,
  keyHashAt,
  ownPaymentPath,
  ownStakePath,
  paymentKeyHashAt,
  paymentKeyHashes,
  rewardAddressOf,
  type SharedScripts,
  scriptsAt,
  stakeKeyHashes,
  stakeKeyHashOf,
} from './derive'
export {
  type DeviceKeyFailure,
  readDeviceSharedAccountXpub,
  sameXpubHex,
  verifyDeviceAccountXpub,
  xpubHexOf,
} from './device-shared-key'
export {
  type DiscoveredAddress,
  type Discovery,
  discoverSharedWallet,
  indexesOf,
  type ScanUtxo,
  type SharedAsset,
  type SharedUtxo,
  scanUtxoOf,
  selectUtxos,
  sharedScanReader,
  sumAssets,
  type UtxoReader,
} from './discovery'
export {
  type CoSignerKeySource,
  canCoSign,
  coSignerKeyAccessOf,
  coSignerKeyIsReady,
  coSignerKeySourceOf,
  type IneligibleReason,
  ineligibleReasonKey,
  reasonKeyOf,
  type SpendingAuthority,
  spendingAuthorityOf,
} from './eligibility'
export {
  type BuildProblem,
  deriveOwnAccountXpub,
  type QuorumStatus,
  quorumStatusOf,
  signedTagsAt,
  signPolicy,
  validateSharedWallet,
  withTags,
} from './model'
export {
  CIP146_LABEL,
  type DecodedRegistration,
  encodeRegistration,
  type MultisigRegistration,
  participantNames,
  type RegistrationParticipant,
  registrationAuxData,
  registrationFor,
  registrationScripts,
  SCRIPT_TYPE,
  type ScriptType,
  scriptOfType,
} from './registration'
export {
  decodeAccountXvk,
  decodeSharedKey,
  encodeAccountXvk,
  encodeSharedKey,
  prefixOf,
  SHARED_PREFIX,
  type SharedKeyError,
  type SharedPrefix,
} from './shared-key'
export {envelopeMeetsPolicy, signersFor, validityFor} from './spend'
export {
  getSharedWallet,
  listSharedWallets,
  newSharedWalletId,
  parseWallet,
  platformSharedWalletRegistry,
  removeSharedWallet,
  type SharedWalletRegistry,
  saveSharedWallet,
  serializeWallet,
} from './storage'
export {
  type CoSignerTag,
  flatTemplate,
  hasTimeLock,
  isSatisfied,
  type ScriptTemplate,
  type TemplateProblem,
  tagAt,
  templateTags,
  validateTemplate,
  validityBounds,
  withTimeLock,
} from './template'
export {
  addressNetworkOf,
  type CoSignerRef,
  MULTISIG_ADDRESS_GAP,
  MULTISIG_PAYMENT_ROLE,
  MULTISIG_STAKE_ROLE,
  type SharedWallet,
  type SharedWalletRegistrationState,
  STAKE_INDEX,
} from './types'
