/**
 * TRON Ledger app support.
 *
 * Provides Effect-based interface for TRON Ledger app operations.
 * Requires @ledgerhq/hw-app-trx to be installed.
 *
 * @module
 */

import TrxAppModule from '@ledgerhq/hw-app-trx'
import {Effect} from 'effect'
import type {HardwareErrorType} from '../../types'
import {mapLedgerError} from '../errors'
import type {LedgerTransport} from '../types'

// ============================================================================
// Types
// ============================================================================

/**
 * TRON address response.
 */
export type TronAddress = {
  /** Base58Check encoded TRON address (starts with T) */
  readonly address: string
  /** Public key hex */
  readonly publicKey: string
}

/**
 * TRON signature result.
 */
export type TronSignature = {
  /** Signature hex (65 bytes - R, S, V) */
  readonly signature: string
}

/**
 * TRON app configuration.
 */
export type TronAppConfiguration = {
  /** App version string */
  readonly version: string
  /** Whether data signing is allowed */
  readonly dataAllowed: boolean
  /** Whether custom contracts are allowed */
  readonly customContractsAllowed: boolean
}

/**
 * Token signature for TRC20 transactions.
 */
export type TronTokenSignature = {
  /** Contract address (base58) */
  readonly contractAddress: string
  /** Token symbol */
  readonly symbol: string
  /** Token decimals */
  readonly decimals: number
  /** Signature from Ledger */
  readonly signature: string
}

// ============================================================================
// App Instance Management
// ============================================================================

/**
 * TRON app interface matching @ledgerhq/hw-app-trx.
 */
type TronApp = {
  getAddress(path: string, display?: boolean): Promise<{address: string; publicKey: string}>
  signTransaction(path: string, rawTxHex: string, tokenSignatures: string[]): Promise<string>
  signTransactionHash(path: string, rawTxHashHex: string): Promise<string>
  signPersonalMessage(path: string, messageHex: string): Promise<string>
  getAppConfiguration(): Promise<{
    version: string
    versionN: number
    allowData: boolean
    allowContract: boolean
    truncateAddress: boolean
    signByHash: boolean
  }>
}

/**
 * Creates a TRON app instance from a transport.
 */
const createTronAppInstance = (transport: unknown): TronApp => {
  const TrxApp = TrxAppModule as unknown as {new (transport: unknown): TronApp}
  return new TrxApp(transport)
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Creates a TRON Ledger app wrapper.
 *
 * @param transport - Ledger transport
 * @returns TRON app operations
 */
/**
 * Strip the `m/` prefix from a derivation path.
 *
 * The Ledger Tron app expects paths like `44'/195'/0'/0/0`, not `m/44'/195'/0'/0/0`.
 */
const stripMPrefix = (path: string): string => (path.startsWith('m/') ? path.slice(2) : path)

export const createTronLedgerApp = (transport: LedgerTransport) => {
  let app: TronApp | null = null

  const getApp = (): TronApp => {
    if (app) return app
    app = createTronAppInstance(transport)
    return app
  }

  return {
    /**
     * Gets a TRON address at the given derivation path.
     *
     * @param path - Derivation path (e.g., "m/44'/195'/0'/0/0")
     * @param verify - Display address on device for verification
     */
    getAddress: (path: string, verify = false): Effect.Effect<TronAddress, HardwareErrorType> =>
      Effect.tryPromise({
        try: async () => {
          const tronApp = getApp()
          const result = await tronApp.getAddress(stripMPrefix(path), verify)
          return {
            address: result.address,
            publicKey: result.publicKey,
          }
        },
        catch: (error) => mapLedgerError(error, 'get TRON address', 'Tron'),
      }),

    /**
     * Signs a TRON transaction with the raw protobuf-encoded transaction data.
     *
     * @param path - Derivation path
     * @param rawTxHex - Raw transaction hex (protobuf encoded raw_data_hex)
     * @param tokenSignatures - Optional token signatures for TRC20 transfers
     */
    signTransaction: (
      path: string,
      rawTxHex: string,
      tokenSignatures: string[] = [],
    ): Effect.Effect<TronSignature, HardwareErrorType> =>
      Effect.tryPromise({
        try: async () => {
          const tronApp = getApp()
          const signature = await tronApp.signTransaction(stripMPrefix(path), rawTxHex, tokenSignatures)
          return {signature}
        },
        catch: (error) => mapLedgerError(error, 'sign TRON transaction', 'Tron'),
      }),

    /**
     * Signs a TRON transaction hash (fallback when raw data is too large).
     *
     * @param path - Derivation path
     * @param txHashHex - Transaction ID / hash hex string
     */
    signTransactionHash: (path: string, txHashHex: string): Effect.Effect<TronSignature, HardwareErrorType> =>
      Effect.tryPromise({
        try: async () => {
          const tronApp = getApp()
          const signature = await tronApp.signTransactionHash(stripMPrefix(path), txHashHex)
          return {signature}
        },
        catch: (error) => mapLedgerError(error, 'sign TRON transaction hash', 'Tron'),
      }),

    /**
     * Signs a personal message (for dApp authentication).
     *
     * @param path - Derivation path
     * @param messageHex - Message to sign (hex encoded)
     */
    signPersonalMessage: (path: string, messageHex: string): Effect.Effect<TronSignature, HardwareErrorType> =>
      Effect.tryPromise({
        try: async () => {
          const tronApp = getApp()
          const signature = await tronApp.signPersonalMessage(stripMPrefix(path), messageHex)
          return {signature}
        },
        catch: (error) => mapLedgerError(error, 'sign TRON personal message', 'Tron'),
      }),

    /**
     * Signs a message string (convenience method).
     *
     * @param path - Derivation path
     * @param message - Message string to sign
     */
    signMessage: (path: string, message: string): Effect.Effect<TronSignature, HardwareErrorType> =>
      Effect.tryPromise({
        try: async () => {
          const tronApp = getApp()
          const messageHex = Array.from(new TextEncoder().encode(message))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
          const signature = await tronApp.signPersonalMessage(stripMPrefix(path), messageHex)
          return {signature}
        },
        catch: (error) => mapLedgerError(error, 'sign TRON message', 'Tron'),
      }),

    /**
     * Gets the TRON app configuration.
     */
    getAppConfiguration: (): Effect.Effect<TronAppConfiguration, HardwareErrorType> =>
      Effect.tryPromise({
        try: async () => {
          const tronApp = getApp()
          const config = await tronApp.getAppConfiguration()
          return {
            version: config.version,
            dataAllowed: config.allowData,
            customContractsAllowed: config.allowContract,
          }
        },
        catch: (error) => mapLedgerError(error, 'get TRON app configuration', 'Tron'),
      }),
  }
}

export type TronLedgerApp = ReturnType<typeof createTronLedgerApp>
