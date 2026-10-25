/**
 * Chain app type map.
 *
 * Maps each `ChainAppType` to the concrete app interface returned by
 * `HardwareDevice.getChainApp()`. Consumers use this for type-safe access:
 *
 * ```typescript
 * import type { LedgerChainAppMap } from './index.js'
 *
 * const btcApp = (yield* device.getChainApp('bitcoin')) as LedgerChainAppMap['bitcoin']
 * const address = yield* btcApp.getAddress("m/84'/0'/0'/0/0")
 * ```
 *
 * Or use the typed helper:
 *
 * ```typescript
 * import { getTypedChainApp } from './index.js'
 *
 * const btcApp = yield* getTypedChainApp<LedgerChainAppMap>(device, 'bitcoin')
 * ```
 *
 * @module
 */

import type {Effect} from 'effect'
import type {BitcoinLedgerApp} from './ledger/apps/bitcoin'
import type {EthereumLedgerApp} from './ledger/apps/ethereum'
import type {SolanaLedgerApp} from './ledger/apps/solana'
import type {TronLedgerApp} from './ledger/apps/tron'
import type {
  TrezorBitcoin,
  TrezorBitcoinCash,
  TrezorDogecoin,
  TrezorEthereum,
  TrezorLitecoin,
  TrezorSolana,
} from './trezor/multichain'
import type {
  CardanoSigningRequest,
  ChainAppType,
  HardwareDevice,
  HardwareErrorType,
  HardwareSignature,
  MessageSigningRequest,
  TransactionWitness,
} from './types'

// ============================================================================
// Cardano Chain App
// ============================================================================

/**
 * Cardano app interface returned by `getChainApp('cardano')`.
 *
 * For Ledger, this wraps the internal Cardano app (same one used by
 * `signCardanoTransaction`). For Trezor, this wraps TrezorConnect's
 * Cardano methods.
 */
export type CardanoChainApp = {
  readonly getExtendedPublicKey: (
    path: string,
  ) => Effect.Effect<{publicKey: string; chainCode: string}, HardwareErrorType>
  readonly signTransaction: (
    request: CardanoSigningRequest,
  ) => Effect.Effect<readonly TransactionWitness[], HardwareErrorType>
  readonly signMessage: (request: MessageSigningRequest) => Effect.Effect<HardwareSignature, HardwareErrorType>
  readonly verifyAddress: (address: string, derivationPath: string) => Effect.Effect<boolean, HardwareErrorType>
}

// ============================================================================
// Ledger Chain App Map
// ============================================================================

/**
 * Maps each chain to the Ledger app type returned by `getChainApp`.
 *
 * All chains are supported on Ledger.
 */
export type LedgerChainAppMap = {
  readonly cardano: CardanoChainApp
  readonly bitcoin: BitcoinLedgerApp
  readonly litecoin: BitcoinLedgerApp
  readonly dogecoin: BitcoinLedgerApp
  readonly 'bitcoin-cash': BitcoinLedgerApp
  readonly ethereum: EthereumLedgerApp
  readonly solana: SolanaLedgerApp
  readonly tron: TronLedgerApp
}

// ============================================================================
// Trezor Chain App Map
// ============================================================================

/**
 * Maps each chain to the Trezor multichain wrapper type returned by `getChainApp`.
 *
 * Cosmos, THORChain, and TRON are `never` — Trezor does not support these chains
 * and `getChainApp` will return `Effect.fail` for them.
 */
export type TrezorChainAppMap = {
  readonly cardano: CardanoChainApp
  readonly bitcoin: TrezorBitcoin
  readonly litecoin: TrezorLitecoin
  readonly dogecoin: TrezorDogecoin
  readonly 'bitcoin-cash': TrezorBitcoinCash
  readonly ethereum: TrezorEthereum
  readonly solana: TrezorSolana
  readonly tron: never
}

// ============================================================================
// Unified Chain App Map
// ============================================================================

/**
 * Union of Ledger and Trezor app types for each chain.
 *
 * Use this when the device type is unknown at compile time.
 * For device-specific typing, use `LedgerChainAppMap` or `TrezorChainAppMap`.
 */
export type ChainAppMap = {
  readonly [K in ChainAppType]: LedgerChainAppMap[K] | TrezorChainAppMap[K]
}

// ============================================================================
// Typed Helper
// ============================================================================

/**
 * Type-safe wrapper around `device.getChainApp()`.
 *
 * Returns the chain app with the correct type for the given chain,
 * eliminating the need for manual casting.
 *
 * @example
 * ```typescript
 * // For a Ledger device:
 * const btcApp = yield* getTypedChainApp<LedgerChainAppMap>(device, 'bitcoin')
 * const addr = yield* btcApp.getAddress("m/84'/0'/0'/0/0")
 *
 * // For a Trezor device:
 * const ethApp = yield* getTypedChainApp<TrezorChainAppMap>(device, 'ethereum')
 * const sig = yield* ethApp.signTransaction("m/44'/60'/0'/0/0", tx)
 * ```
 *
 * @param device - Hardware device instance
 * @param chain - Chain identifier
 * @returns Effect with the typed chain app
 */
export const getTypedChainApp = <M extends Record<ChainAppType, unknown>, C extends ChainAppType>(
  device: HardwareDevice,
  chain: C,
): Effect.Effect<M[C], HardwareErrorType> => device.getChainApp(chain) as Effect.Effect<M[C], HardwareErrorType>
