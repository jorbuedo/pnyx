/**
 * Ethereum Ledger app support.
 *
 * Provides Effect-based interface for Ethereum Ledger app operations.
 * Requires @ledgerhq/hw-app-eth to be installed.
 *
 * @module
 */

import EthAppModule from '@ledgerhq/hw-app-eth'
import {getLogger} from '@pnyx/logger'
import {Effect} from 'effect'
import type {HardwareErrorType} from '../../types'
import {isConnectionError, isStaleSessionError, mapLedgerError} from '../errors'
import type {LedgerTransport} from '../types'

const logger = getLogger('hardware')

// ============================================================================
// Types
// ============================================================================

/**
 * Ethereum address response.
 */
export type EthereumAddress = {
  /** Public key hex */
  readonly publicKey: string
  /** Ethereum address (0x prefixed) */
  readonly address: string
  /** Chain code (for HD derivation) */
  readonly chainCode?: string | undefined
}

/**
 * Ethereum transaction request.
 */
export type EthereumTxRequest = {
  /** Derivation path */
  readonly path: string
  /** Raw unsigned transaction (RLP encoded hex) */
  readonly rawTxHex: string
  /** Chain ID for EIP-155 replay protection */
  readonly chainId?: number
}

/**
 * Ethereum signature.
 */
export type EthereumSignature = {
  /** v value */
  readonly v: string
  /** r value (hex) */
  readonly r: string
  /** s value (hex) */
  readonly s: string
}

/**
 * EIP-712 typed data for signing.
 */
export type EthereumTypedData = {
  /** Domain separator */
  readonly domain: {
    readonly name?: string
    readonly version?: string
    readonly chainId?: number
    readonly verifyingContract?: string
    readonly salt?: string
  }
  /** Type definitions */
  readonly types: Record<string, readonly {name: string; type: string}[]>
  /** Primary type name */
  readonly primaryType: string
  /** Message to sign */
  readonly message: Record<string, unknown>
}

/**
 * EIP-712 signing options.
 */
export type EthereumTypedDataOptions = {
  /** Full EIP-712 struct implementation */
  readonly implementation?: 'full'
  /** Domain separator hash (for v0 implementation) */
  readonly domainSeparatorHex?: string
  /** Hashed struct data (for v0 implementation) */
  readonly hashStructMessageHex?: string
}

/**
 * Resolution hints for Ledger clear signing.
 *
 * These instruct the Ledger SDK to resolve trusted metadata (ERC-20, NFTs,
 * external plugins such as swap routers) before signing. If resolution fails,
 * the SDK falls back to the regular signing path internally.
 */
const DEFAULT_CLEAR_SIGN_RESOLUTION = {
  erc20: true,
  nft: false,
  externalPlugins: true,
  uniswapV3: true,
} as const

// ============================================================================
// App Instance Management
// ============================================================================

/**
 * Ethereum app interface.
 */
type EthereumApp = {
  getAddress(
    path: string,
    boolDisplay?: boolean,
    boolChaincode?: boolean,
  ): Promise<{publicKey: string; address: string; chainCode?: string}>
  signTransaction(path: string, rawTxHex: string, resolution?: unknown): Promise<{v: string; r: string; s: string}>
  clearSignTransaction?(
    path: string,
    rawTxHex: string,
    resolutionConfig: typeof DEFAULT_CLEAR_SIGN_RESOLUTION,
    throwOnError?: boolean,
  ): Promise<{v: string; r: string; s: string}>
  signPersonalMessage(path: string, messageHex: string): Promise<{v: number; r: string; s: string}>
  signEIP712HashedMessage(
    path: string,
    domainSeparatorHex: string,
    hashStructMessageHex: string,
  ): Promise<{v: number; r: string; s: string}>
  signEIP712Message(
    path: string,
    jsonMessage: EthereumTypedData,
    fullImplem?: boolean,
  ): Promise<{v: number; r: string; s: string}>
  getAppConfiguration(): Promise<{
    arbitraryDataEnabled: number
    erc20ProvisioningNecessary: number
    starkEnabled: number
    version: string
  }>
}

/**
 * Creates an Ethereum app instance from a transport.
 */
const createEthAppInstance = (transport: unknown): EthereumApp => {
  const EthApp = EthAppModule as unknown as {new (transport: unknown): EthereumApp}
  return new EthApp(transport)
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Creates an Ethereum Ledger app wrapper.
 *
 * @param transport - Ledger transport
 * @returns Ethereum app operations
 */
export const createEthereumLedgerApp = (transport: LedgerTransport) => {
  let app: EthereumApp | null = null

  const getApp = (): EthereumApp => {
    if (app) return app
    app = createEthAppInstance(transport)
    return app
  }

  // Drop the cached EthApp on transport or stale-session errors so the next
  // call rebinds against the current transport. The hw-app-eth instance
  // buffers internal state (resolution caches, partial INS chains) that
  // becomes inconsistent once the device returns a framing error (0x6a87)
  // or the transport resets — reusing it can otherwise yield truncated
  // responses on the following call. User rejections / blind-signing
  // prompts / device-locked do not corrupt the wrapper, so keep the cache.
  const withCacheInvalidation = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (error) {
      if (isStaleSessionError(error) || isConnectionError(error)) app = null
      throw error
    }
  }

  return {
    /**
     * Gets an Ethereum address at the given derivation path.
     *
     * @param path - Derivation path (e.g., "m/44'/60'/0'/0/0")
     * @param verify - Display address on device for verification
     * @param withChainCode - Include chain code in response
     */
    getAddress: (
      path: string,
      verify = false,
      withChainCode = false,
    ): Effect.Effect<EthereumAddress, HardwareErrorType> =>
      Effect.tryPromise({
        try: () =>
          withCacheInvalidation(async () => {
            const ethApp = getApp()
            const result = await ethApp.getAddress(path, verify, withChainCode)
            return {
              publicKey: result.publicKey,
              address: result.address,
              chainCode: result.chainCode,
            }
          }),
        catch: (error) => mapLedgerError(error, 'get Ethereum address', 'Ethereum'),
      }),

    /**
     * Signs an Ethereum transaction.
     *
     * @param request - Transaction signing request
     */
    signTransaction: (request: EthereumTxRequest): Effect.Effect<EthereumSignature, HardwareErrorType> =>
      Effect.tryPromise({
        try: () =>
          withCacheInvalidation(async () => {
            const ethApp = getApp()
            const result =
              typeof ethApp.clearSignTransaction === 'function'
                ? await ethApp
                    .clearSignTransaction(request.path, request.rawTxHex, DEFAULT_CLEAR_SIGN_RESOLUTION)
                    .catch((e) => {
                      logger.warn('Clear-sign refused; falling back to blind signing', {
                        origin: 'LedgerEthereum',
                        error: String(e),
                      })
                      return ethApp.signTransaction(request.path, request.rawTxHex)
                    })
                : await ethApp.signTransaction(request.path, request.rawTxHex)
            return {v: result.v, r: result.r, s: result.s}
          }),
        catch: (error) => mapLedgerError(error, 'sign Ethereum transaction', 'Ethereum'),
      }),

    /**
     * Signs a personal message (EIP-191).
     *
     * @param path - Derivation path
     * @param message - Message to sign (hex encoded, without prefix)
     */
    signPersonalMessage: (path: string, message: string): Effect.Effect<EthereumSignature, HardwareErrorType> =>
      Effect.tryPromise({
        try: () =>
          withCacheInvalidation(async () => {
            const ethApp = getApp()
            const result = await ethApp.signPersonalMessage(path, message)
            return {v: String(result.v), r: result.r, s: result.s}
          }),
        catch: (error) => mapLedgerError(error, 'sign Ethereum message', 'Ethereum'),
      }),

    /**
     * Signs EIP-712 typed data.
     *
     * @param path - Derivation path
     * @param typedData - Typed data to sign
     * @param options - Signing options
     */
    signTypedData: (
      path: string,
      typedData: EthereumTypedData,
      options?: EthereumTypedDataOptions,
    ): Effect.Effect<EthereumSignature, HardwareErrorType> =>
      Effect.tryPromise({
        try: () =>
          withCacheInvalidation(async () => {
            const ethApp = getApp()

            // Use hashed message approach if provided
            if (options?.domainSeparatorHex && options?.hashStructMessageHex) {
              const result = await ethApp.signEIP712HashedMessage(
                path,
                options.domainSeparatorHex,
                options.hashStructMessageHex,
              )
              return {v: String(result.v), r: result.r, s: result.s}
            }

            // Use full implementation
            const result = await ethApp.signEIP712Message(path, typedData, options?.implementation === 'full')
            return {v: String(result.v), r: result.r, s: result.s}
          }),
        catch: (error) => mapLedgerError(error, 'sign Ethereum typed data', 'Ethereum'),
      }),

    /**
     * Gets the Ethereum app configuration.
     */
    getAppConfiguration: (): Effect.Effect<
      {version: string; arbitraryDataEnabled: boolean; erc20ProvisioningNecessary: boolean},
      HardwareErrorType
    > =>
      Effect.tryPromise({
        try: () =>
          withCacheInvalidation(async () => {
            const ethApp = getApp()
            const config = await ethApp.getAppConfiguration()
            return {
              version: config.version,
              arbitraryDataEnabled: config.arbitraryDataEnabled === 1,
              erc20ProvisioningNecessary: config.erc20ProvisioningNecessary === 1,
            }
          }),
        catch: (error) => mapLedgerError(error, 'get Ethereum app configuration', 'Ethereum'),
      }),
  }
}

export type EthereumLedgerApp = ReturnType<typeof createEthereumLedgerApp>
