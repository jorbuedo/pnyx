/**
 * Derivation path utilities for multi-chain support.
 *
 * Provides chain-specific derivation path generation and parsing
 * following BIP-32, BIP-44, BIP-84, and chain-specific standards.
 *
 * @module
 */

export type {
  BitcoinAddressType as BitcoinAddressTypeValue,
  BitcoinPurpose as BitcoinPurposeValue,
} from './derivation/bitcoin'
export {
  BITCOIN_COIN_TYPE,
  BITCOIN_TESTNET_COIN_TYPE,
  BitcoinAddressType,
  BitcoinPurpose,
  bitcoinAccountPath,
  bitcoinAddressPath,
  bitcoinLegacyPath,
  bitcoinNativeSegwitPath,
  bitcoinTaprootPath,
  isBitcoinPath,
  parseBitcoinPath,
  purposeForAddressType,
} from './derivation/bitcoin'
export type {CardanoRole as CardanoRoleType} from './derivation/cardano'
// Re-export with explicit names to avoid conflicts
export {
  CARDANO_COIN_TYPE,
  CARDANO_PURPOSE,
  CardanoRole,
  cardanoAccountPath,
  cardanoAddressPath,
  cardanoDRepPath,
  cardanoExternalPath,
  cardanoInternalPath,
  cardanoStakingPath,
  isCardanoPath,
  parseCardanoPath,
} from './derivation/cardano'
export {
  ETHEREUM_COIN_TYPE,
  EVMCoinType,
  ethereumAccountPath,
  ethereumAddressPath,
  ethereumClassicPath,
  ethereumDefaultPath,
  ethereumLedgerLivePath,
  ethereumMetamaskPath,
  isEthereumPath,
  parseEthereumPath,
} from './derivation/ethereum'
// Service-level path helpers
export type {HardwareDeviceType} from './derivation/service-paths'
export {getAccountPath, getAddressPath} from './derivation/service-paths'
// Re-export shared utilities
export {
  formatDerivationPath,
  HARDENED,
  harden,
  isHardened,
  parseDerivationPath,
  unharden,
} from './derivation/shared'
export {
  isSolanaPath,
  parseSolanaPath,
  SOLANA_COIN_TYPE,
  solanaAccountPath,
  solanaAddressPath,
  solanaDefaultPath,
  solanaLedgerPath,
} from './derivation/solana'
export {
  isTronPath,
  parseTronPath,
  TRON_COIN_TYPE,
  tronAccountPath,
  tronAddressPath,
  tronDefaultPath,
  tronLedgerPath,
  tronLinkPath,
} from './derivation/tron'
