/**
 * Credential vault barrel.
 *
 * @module
 */

export {
  beginCeremony,
  type CeremonyHandle,
  clearAllCeremonies,
  evictGroupCeremony,
  getCachedMaterial,
  isCeremonyActive,
  setCachedMaterial,
} from './ceremony-cache'
export {createEnclaveMnemonicVault, type EnclaveMnemonicVault, groupIdFromService} from './enclave-vault'
export {VaultError} from './types'
