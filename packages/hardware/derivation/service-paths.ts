/**
 * Chain-specific derivation path helpers for the hardware wallet service.
 *
 * Maps ChainId to the correct derivation path format for account
 * and address derivation on hardware devices.
 *
 * @module
 */

import {
  ARBITRUM_ONE,
  AURORA_MAINNET,
  AVALANCHE_MAINNET,
  BASE_MAINNET,
  BINANCE_MAINNET,
  BITCOIN_CASH_MAINNET,
  BITCOIN_MAINNET,
  CARDANO_MAINNET,
  CELO_MAINNET,
  type ChainId,
  CRONOS_MAINNET,
  DOGECOIN_MAINNET,
  ETHEREUM_MAINNET,
  FANTOM_MAINNET,
  GNOSIS_MAINNET,
  KLAYTN_MAINNET,
  LINEA_MAINNET,
  LITECOIN_MAINNET,
  MANTLE_MAINNET,
  MOONBEAM_MAINNET,
  OPTIMISM_MAINNET,
  POLYGON_MAINNET,
  SCROLL_MAINNET,
  SOLANA_MAINNET,
  TRON_MAINNET,
  ZKSYNC_MAINNET,
} from '@pnyx/config'

import {BitcoinPurpose, bitcoinAccountPath, bitcoinLegacyPath, bitcoinNativeSegwitPath} from './bitcoin'
import {cardanoAccountPath, cardanoAddressPath} from './cardano'
import {ethereumAccountPath, ethereumAddressPath} from './ethereum'
import {solanaAccountPath, solanaLedgerPath} from './solana'
import {tronAccountPath, tronAddressPath} from './tron'

/**
 * Hardware device type for path resolution.
 * Different devices use different derivation depths for some chains.
 */
export type HardwareDeviceType = 'ledger' | 'trezor'

/**
 * Get the account derivation path for a chain.
 */
export const getAccountPath = (chain: ChainId, accountIndex: number): string => {
  switch (chain) {
    case CARDANO_MAINNET:
      return cardanoAccountPath(accountIndex)
    case BITCOIN_MAINNET:
      return bitcoinAccountPath(BitcoinPurpose.BIP84, accountIndex)
    case ETHEREUM_MAINNET:
    case POLYGON_MAINNET:
    case BINANCE_MAINNET:
    case ARBITRUM_ONE:
    case OPTIMISM_MAINNET:
    case AVALANCHE_MAINNET:
    case BASE_MAINNET:
    case FANTOM_MAINNET:
    case GNOSIS_MAINNET:
    case CRONOS_MAINNET:
    case MOONBEAM_MAINNET:
    case AURORA_MAINNET:
    case CELO_MAINNET:
    case KLAYTN_MAINNET:
    case LINEA_MAINNET:
    case SCROLL_MAINNET:
    case ZKSYNC_MAINNET:
    case MANTLE_MAINNET:
      return ethereumAccountPath(accountIndex)
    case SOLANA_MAINNET:
      return solanaAccountPath(accountIndex)
    case LITECOIN_MAINNET:
      // Litecoin uses BIP-84 with coin type 2
      return bitcoinAccountPath(BitcoinPurpose.BIP84, accountIndex, true) // Use testnet flag for alt coin type workaround
    case DOGECOIN_MAINNET:
      // Dogecoin uses BIP-44 legacy with coin type 3
      return bitcoinAccountPath(BitcoinPurpose.BIP44, accountIndex)
    case BITCOIN_CASH_MAINNET:
      // Bitcoin Cash uses BIP-44 legacy with coin type 145
      return bitcoinAccountPath(BitcoinPurpose.BIP44, accountIndex)
    case TRON_MAINNET:
      return tronAccountPath(accountIndex)
    default:
      // Default to Ethereum-style for unknown chains
      return ethereumAccountPath(accountIndex)
  }
}

/**
 * Get the address derivation path for a chain.
 *
 * Solana paths differ by device:
 * - Ledger: m/44'/501'/account' (3 levels, solanaLedgerPath)
 * - Trezor: m/44'/501'/account'/0' (4 levels, solanaAccountPath)
 */
export const getAddressPath = (
  chain: ChainId,
  accountIndex: number,
  addressIndex: number,
  deviceType?: HardwareDeviceType,
): string => {
  switch (chain) {
    case CARDANO_MAINNET:
      // Cardano uses role 0 (external) for receive addresses
      return cardanoAddressPath(accountIndex, 0, addressIndex)
    case BITCOIN_MAINNET:
      return bitcoinNativeSegwitPath(accountIndex, 0, addressIndex)
    case ETHEREUM_MAINNET:
    case POLYGON_MAINNET:
    case BINANCE_MAINNET:
    case ARBITRUM_ONE:
    case OPTIMISM_MAINNET:
    case AVALANCHE_MAINNET:
    case BASE_MAINNET:
    case FANTOM_MAINNET:
    case GNOSIS_MAINNET:
    case CRONOS_MAINNET:
    case MOONBEAM_MAINNET:
    case AURORA_MAINNET:
    case CELO_MAINNET:
    case KLAYTN_MAINNET:
    case LINEA_MAINNET:
    case SCROLL_MAINNET:
    case ZKSYNC_MAINNET:
    case MANTLE_MAINNET:
      return ethereumAddressPath(accountIndex, addressIndex)
    case SOLANA_MAINNET:
      // Ledger uses 3-level path (m/44'/501'/account'), Trezor uses 4-level
      return deviceType === 'ledger' ? solanaLedgerPath(accountIndex) : solanaAccountPath(accountIndex)
    case LITECOIN_MAINNET:
      return bitcoinNativeSegwitPath(accountIndex, 0, addressIndex, true) // Alt coin workaround
    case DOGECOIN_MAINNET:
      return bitcoinLegacyPath(accountIndex, 0, addressIndex)
    case BITCOIN_CASH_MAINNET:
      return bitcoinLegacyPath(accountIndex, 0, addressIndex)
    case TRON_MAINNET:
      return tronAddressPath(accountIndex, addressIndex)
    default:
      return ethereumAddressPath(accountIndex, addressIndex)
  }
}
