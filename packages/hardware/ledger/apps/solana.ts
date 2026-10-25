/**
 * Solana Ledger app support.
 *
 * Provides Effect-based interface for Solana Ledger app operations.
 * Requires @ledgerhq/hw-app-solana to be installed.
 *
 * @module
 */

import {Effect} from 'effect'
import {parseSolanaPath} from '../../derivation/solana'
import {HardwareError, type HardwareErrorType} from '../../types'
import {mapLedgerError} from '../errors'
import type {LedgerTransport} from '../types'

// ============================================================================
// Types
// ============================================================================

/**
 * Solana address response.
 */
export type SolanaAddress = {
  /** Public key (base58) */
  readonly address: string
  /** Raw public key bytes */
  readonly publicKey: Uint8Array
}

/**
 * Solana signature result.
 */
export type SolanaSignature = {
  /** Signature bytes (64 bytes for Ed25519) */
  readonly signature: Uint8Array
}

/**
 * Solana app configuration.
 */
export type SolanaAppConfiguration = {
  /** App version */
  readonly version: string
  /** Whether blind signing is enabled */
  readonly blindSigningEnabled: boolean
  /** Whether pubkey display is allowed */
  readonly pubkeyDisplayAllowed: boolean
}

// ============================================================================
// App Instance Management
// ============================================================================

/**
 * Solana app interface.
 */
type SolanaApp = {
  getAddress(path: string, display?: boolean): Promise<{address: Uint8Array}>
  signTransaction(path: string, txBuffer: Uint8Array): Promise<{signature: Uint8Array}>
  signOffchainMessage(path: string, message: Uint8Array): Promise<{signature: Uint8Array}>
  getAppConfiguration(): Promise<{version: string; blindSigningEnabled: boolean; pubkeyDisplayAllowed: boolean}>
  getChallenge(): Promise<string>
}

/**
 * Lazily loaded Solana app creator.
 */
let createSolAppInstance: ((transport: unknown) => SolanaApp) | null = null

/**
 * Loads the Solana app creator.
 */
const loadSolanaAppCreator = async (): Promise<(transport: unknown) => SolanaApp> => {
  if (createSolAppInstance) return createSolAppInstance

  try {
    const module = (await import('@ledgerhq/hw-app-solana' as string)) as unknown as {
      default?: {new (transport: unknown): SolanaApp}
    }
    const AppClass = module.default
    if (!AppClass) {
      throw new Error('Solana app class not found in module')
    }
    createSolAppInstance = (transport: unknown) => new AppClass(transport)
    return createSolAppInstance
  } catch (error) {
    throw new Error(
      `Failed to load @ledgerhq/hw-app-solana: ${error instanceof Error ? error.message : String(error)}. Please install it.`,
    )
  }
}

/**
 * Simple base58 encoder (for Solana addresses).
 */
const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

const encodeBase58 = (buffer: Uint8Array): string => {
  const bytes = Array.from(buffer)

  // Count leading zeros
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) {
    zeros++
  }

  // Convert to base58
  const result: number[] = []
  for (const byte of bytes) {
    let carry = byte
    for (let j = 0; j < result.length; j++) {
      carry += (result[j] ?? 0) * 256
      result[j] = carry % 58
      carry = Math.floor(carry / 58)
    }
    while (carry > 0) {
      result.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }

  // Add leading '1's for each leading zero byte
  let encoded = ''
  for (let i = 0; i < zeros; i++) {
    encoded += '1'
  }

  // Convert to characters
  for (let i = result.length - 1; i >= 0; i--) {
    encoded += base58Alphabet[result[i] ?? 0]
  }

  return encoded
}

const validateLedgerSolanaPath = (path: string): string => {
  const parsed = parseSolanaPath(path)
  if (!parsed) {
    throw new HardwareError({
      message: `Invalid Solana derivation path "${path}". Ledger Solana expects account-level paths like m/44'/501'/0'.`,
    })
  }
  if (parsed.change !== undefined) {
    throw new HardwareError({
      message: `Ledger Solana expects account-level derivation paths like m/44'/501'/0', but received "${path}".`,
    })
  }
  return path.replace(/^m\//, '')
}

const mapSolanaLedgerError = (error: unknown, operation: string): HardwareErrorType =>
  error instanceof HardwareError ? error : mapLedgerError(error, operation, 'Solana')

// ============================================================================
// Public API
// ============================================================================

/**
 * Creates a Solana Ledger app wrapper.
 *
 * @param transport - Ledger transport
 * @returns Solana app operations
 */
export const createSolanaLedgerApp = (transport: LedgerTransport) => {
  let app: SolanaApp | null = null

  const getApp = async (): Promise<SolanaApp> => {
    if (app) return app
    const creator = await loadSolanaAppCreator()
    app = creator(transport)
    return app
  }

  return {
    /**
     * Gets a Solana address at the given derivation path.
     *
     * @param path - Derivation path (e.g., "m/44'/501'/0'")
     * @param verify - Display address on device for verification
     */
    getAddress: (path: string, verify = false): Effect.Effect<SolanaAddress, HardwareErrorType> =>
      Effect.tryPromise({
        try: async () => {
          const solApp = await getApp()
          // Validate the caller supplied the Ledger-specific 3-level account
          // path, then strip the "m/" prefix — @ledgerhq/hw-app-solana's
          // pathToBuffer auto-hardens
          // all path components, which turns "m" into "m'" and breaks bip32-path parsing.
          const ledgerPath = validateLedgerSolanaPath(path)
          const result = await solApp.getAddress(ledgerPath, verify)
          const publicKey = new Uint8Array(result.address)
          return {
            address: encodeBase58(publicKey),
            publicKey,
          }
        },
        catch: (error) => mapSolanaLedgerError(error, 'get Solana address'),
      }),

    /**
     * Signs a Solana transaction.
     *
     * @param path - Derivation path
     * @param transaction - Serialized transaction bytes
     */
    signTransaction: (path: string, transaction: Uint8Array): Effect.Effect<SolanaSignature, HardwareErrorType> =>
      Effect.tryPromise({
        try: async () => {
          const solApp = await getApp()
          const ledgerPath = validateLedgerSolanaPath(path)
          const result = await solApp.signTransaction(ledgerPath, Buffer.from(transaction))
          return {
            signature: new Uint8Array(result.signature),
          }
        },
        catch: (error) => mapSolanaLedgerError(error, 'sign Solana transaction'),
      }),

    /**
     * Signs an off-chain message.
     *
     * @param path - Derivation path
     * @param message - Message bytes to sign
     */
    signMessage: (path: string, message: Uint8Array): Effect.Effect<SolanaSignature, HardwareErrorType> =>
      Effect.tryPromise({
        try: async () => {
          const solApp = await getApp()
          const ledgerPath = validateLedgerSolanaPath(path)
          const result = await solApp.signOffchainMessage(ledgerPath, message)
          return {
            signature: new Uint8Array(result.signature),
          }
        },
        catch: (error) => mapSolanaLedgerError(error, 'sign Solana message'),
      }),

    /**
     * Gets the Solana app configuration.
     */
    getAppConfiguration: (): Effect.Effect<SolanaAppConfiguration, HardwareErrorType> =>
      Effect.tryPromise({
        try: async () => {
          const solApp = await getApp()
          const config = await solApp.getAppConfiguration()
          return {
            version: config.version,
            blindSigningEnabled: config.blindSigningEnabled,
            pubkeyDisplayAllowed: config.pubkeyDisplayAllowed,
          }
        },
        catch: (error) => mapLedgerError(error, 'get Solana app configuration', 'Solana'),
      }),
  }
}

export type SolanaLedgerApp = ReturnType<typeof createSolanaLedgerApp>
