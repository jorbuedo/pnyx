/**
 * Trezor multi-chain support module.
 *
 * Provides Effect-based interfaces for Bitcoin, Ethereum, and Solana
 * operations on Trezor devices.
 *
 * @module
 */

import {Effect} from 'effect'
import type {HardwareErrorType} from '../types'
import {parseDerivationPath} from '../utils'
import {extractTrezorError, extractTrezorFailureCode, mapTrezorError} from './errors'
import type {TrezorResponse} from './types'

// ============================================================================
// Types
// ============================================================================

/**
 * Bitcoin script types for Trezor.
 */
export const BitcoinScriptType = {
  /** Legacy P2PKH */
  SPENDADDRESS: 'SPENDADDRESS',
  /** Multisig */
  SPENDMULTISIG: 'SPENDMULTISIG',
  /** Native SegWit P2WPKH */
  SPENDWITNESS: 'SPENDWITNESS',
  /** Nested SegWit P2SH-P2WPKH */
  SPENDP2SHWITNESS: 'SPENDP2SHWITNESS',
  /** Taproot P2TR */
  SPENDTAPROOT: 'SPENDTAPROOT',
} as const

export type BitcoinScriptType = (typeof BitcoinScriptType)[keyof typeof BitcoinScriptType]

/**
 * Bitcoin output script types.
 */
export const BitcoinOutputScriptType = {
  PAYTOADDRESS: 'PAYTOADDRESS',
  PAYTOSCRIPTHASH: 'PAYTOSCRIPTHASH',
  PAYTOWITNESS: 'PAYTOWITNESS',
  PAYTOTAPROOT: 'PAYTOTAPROOT',
} as const

export type BitcoinOutputScriptType = (typeof BitcoinOutputScriptType)[keyof typeof BitcoinOutputScriptType]

/**
 * Bitcoin transaction input for Trezor.
 */
export type TrezorBitcoinInput = {
  /** Derivation path components */
  readonly path: string
  /** Previous transaction hash */
  readonly prevTxHash: string
  /** Previous output index */
  readonly prevIndex: number
  /** Amount in satoshis */
  readonly amount: bigint
  /** Script type */
  readonly scriptType?: BitcoinScriptType
}

/**
 * Bitcoin transaction output for Trezor.
 */
export type TrezorBitcoinOutput = {
  /** Destination address (for external) */
  readonly address?: string
  /** Derivation path (for change) */
  readonly path?: string
  /** Amount in satoshis */
  readonly amount: bigint
  /** Script type */
  readonly scriptType?: BitcoinOutputScriptType
}

/**
 * Bitcoin transaction signing options.
 */
/** Previous transaction data for Trezor input verification. */
export type TrezorBitcoinRefTx = {
  readonly version: number
  readonly locktime: number
  readonly inputs: ReadonlyArray<{
    prev_hash: string
    prev_index: number
    script_sig: string
    sequence: number
  }>
  readonly bin_outputs: ReadonlyArray<{
    amount: string
    script_pubkey: string
  }>
  readonly extra_data?: string
}

export type TrezorBitcoinOptions = {
  /** Coin name (btc, ltc, doge, etc.) */
  readonly coin?: string
  /** Push transaction after signing */
  readonly push?: boolean
  /** Locktime */
  readonly locktime?: number
  /** Transaction version */
  readonly version?: number
  /** Previous transactions keyed by tx hash (for input amount verification) */
  readonly refTxs?: ReadonlyMap<string, TrezorBitcoinRefTx>
}

/**
 * Bitcoin transaction result.
 */
export type TrezorBitcoinSignResult = {
  /** Serialized signed transaction hex */
  readonly serializedTx: string
  /** Array of signatures */
  readonly signatures: readonly string[]
}

/**
 * Ethereum transaction for Trezor.
 */
export type TrezorEthereumTx = {
  /** Recipient address */
  readonly to: string
  /** Value in wei (hex) */
  readonly value: string
  /** Gas limit (hex) */
  readonly gasLimit: string
  /** Max fee per gas for EIP-1559 (hex) */
  readonly maxFeePerGas?: string
  /** Max priority fee for EIP-1559 (hex) */
  readonly maxPriorityFeePerGas?: string
  /** Gas price for legacy tx (hex) */
  readonly gasPrice?: string
  /** Nonce (hex) */
  readonly nonce: string
  /** Chain ID */
  readonly chainId: number
  /** Data/input (hex) */
  readonly data?: string
}

/**
 * Ethereum signature result.
 */
export type TrezorEthereumSignature = {
  /** v value */
  readonly v: string
  /** r value */
  readonly r: string
  /** s value */
  readonly s: string
}

/**
 * EIP-712 typed data.
 */
export type TrezorEIP712Data = {
  readonly domain: {
    readonly name?: string
    readonly version?: string
    readonly chainId?: number
    readonly verifyingContract?: string
    readonly salt?: string
  }
  readonly types: Record<string, readonly {name: string; type: string}[]>
  readonly primaryType: string
  readonly message: Record<string, unknown>
}

/**
 * Solana signature result.
 */
export type TrezorSolanaSignature = {
  /** Base58 encoded signature */
  readonly signature: string
}

// ============================================================================
// TrezorConnect Interface (for multi-chain)
// ============================================================================

/**
 * TrezorConnect multi-chain interface.
 */
export type TrezorConnectMultichain = {
  // Bitcoin methods
  getPublicKey(params: {
    path: string
    coin?: string
    showOnTrezor?: boolean
  }): Promise<TrezorResponse<{publicKey: string; node: {chain_code: string}}>>
  getAddress(params: {
    path: string
    coin?: string
    showOnTrezor?: boolean
    scriptType?: BitcoinScriptType
  }): Promise<TrezorResponse<{address: string}>>
  signTransaction(params: {
    inputs: Array<{
      address_n: readonly number[]
      prev_hash: string
      prev_index: number
      amount: string
      script_type?: BitcoinScriptType
    }>
    outputs: Array<{
      address?: string
      address_n?: readonly number[]
      amount: string
      script_type?: BitcoinOutputScriptType
    }>
    coin?: string
    push?: boolean
    locktime?: number
    version?: number
  }): Promise<TrezorResponse<{serializedTx: string; signatures: string[]}>>
  signMessage(params: {
    path: string
    coin?: string
    message: string
  }): Promise<TrezorResponse<{signature: string; address: string}>>

  // Ethereum methods
  ethereumGetPublicKey(params: {
    path: string
    showOnTrezor?: boolean
  }): Promise<TrezorResponse<{publicKey: string; node: {chain_code: string}}>>
  ethereumGetAddress(params: {path: string; showOnTrezor?: boolean}): Promise<TrezorResponse<{address: string}>>
  ethereumSignTransaction(params: {
    path: string
    transaction: TrezorEthereumTx
  }): Promise<TrezorResponse<TrezorEthereumSignature>>
  ethereumSignMessage(params: {
    path: string
    message: string
    hex?: boolean
  }): Promise<TrezorResponse<{signature: string; address: string}>>
  ethereumSignTypedData(params: {
    path: string
    data: TrezorEIP712Data
    metamask_v4_compat?: boolean
  }): Promise<TrezorResponse<{signature: string; address: string}>>

  // Solana methods
  solanaGetPublicKey(params: {path: string; showOnTrezor?: boolean}): Promise<TrezorResponse<{publicKey: string}>>
  solanaGetAddress(params: {path: string; showOnTrezor?: boolean}): Promise<TrezorResponse<{address: string}>>
  solanaSignTransaction(params: {
    path: string
    serializedTx: string
    tokenAccountsInfos?: Array<{
      baseAddress: string
      tokenProgram: string
      tokenMint: string
      tokenAccount: string
    }>
  }): Promise<TrezorResponse<{signature: string}>>
}

// ============================================================================
// Bitcoin Operations
// ============================================================================

/**
 * Creates Bitcoin operations wrapper for Trezor.
 */
export const createTrezorBitcoin = (trezorConnect: TrezorConnectMultichain) => {
  /**
   * Wraps a TrezorConnect call with error handling.
   */
  const withTrezor = <T>(
    operation: string,
    fn: () => Promise<TrezorResponse<T>>,
  ): Effect.Effect<T, HardwareErrorType> =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: fn,
        catch: (error) => mapTrezorError(error, operation),
      })

      if (!response.success) {
        const failureResponse = response as {success: false; payload: {error: string; code?: string}}
        const errorMessage = extractTrezorError(failureResponse)
        const failureCode = extractTrezorFailureCode(failureResponse)
        return yield* Effect.fail(mapTrezorError(new Error(errorMessage), operation, failureCode))
      }

      return response.payload
    })

  return {
    /**
     * Gets a Bitcoin extended public key.
     */
    getPublicKey: (
      path: string,
      coin = 'Bitcoin',
      verify = false,
    ): Effect.Effect<{publicKey: string; chainCode: string}, HardwareErrorType> =>
      Effect.gen(function* () {
        const result = yield* withTrezor('getPublicKey', () =>
          trezorConnect.getPublicKey({path, coin, showOnTrezor: verify}),
        )
        return {
          publicKey: result.publicKey,
          chainCode: result.node.chain_code,
        }
      }),

    /**
     * Gets a Bitcoin address.
     */
    getAddress: (
      path: string,
      coin = 'Bitcoin',
      verify = false,
      scriptType?: BitcoinScriptType,
    ): Effect.Effect<string, HardwareErrorType> =>
      Effect.gen(function* () {
        const result = yield* withTrezor('getAddress', () =>
          trezorConnect.getAddress({
            path,
            coin,
            showOnTrezor: verify,
            ...(scriptType !== undefined ? {scriptType} : {}),
          }),
        )
        return result.address
      }),

    /**
     * Signs a Bitcoin transaction.
     */
    signTransaction: (
      inputs: readonly TrezorBitcoinInput[],
      outputs: readonly TrezorBitcoinOutput[],
      options?: TrezorBitcoinOptions,
    ): Effect.Effect<TrezorBitcoinSignResult, HardwareErrorType> =>
      Effect.gen(function* () {
        const trezorInputs = inputs.map((input) => ({
          address_n: parseDerivationPath(input.path),
          prev_hash: input.prevTxHash,
          prev_index: input.prevIndex,
          amount: input.amount.toString(),
          ...(input.scriptType !== undefined ? {script_type: input.scriptType} : {}),
        }))

        const trezorOutputs = outputs.map((output) => ({
          ...(output.address !== undefined ? {address: output.address} : {}),
          ...(output.path !== undefined ? {address_n: parseDerivationPath(output.path)} : {}),
          amount: output.amount.toString(),
          ...(output.scriptType !== undefined ? {script_type: output.scriptType} : {}),
        }))

        const result = yield* withTrezor('signTransaction', () =>
          trezorConnect.signTransaction({
            inputs: trezorInputs,
            outputs: trezorOutputs,
            coin: options?.coin ?? 'Bitcoin',
            push: options?.push ?? false,
            ...(options?.locktime !== undefined ? {locktime: options.locktime} : {}),
            ...(options?.version !== undefined ? {version: options.version} : {}),
            ...(options?.refTxs !== undefined ? {refTxs: options.refTxs} : {}),
          }),
        )

        return {
          serializedTx: result.serializedTx,
          signatures: result.signatures,
        }
      }),

    /**
     * Signs a message with a Bitcoin key.
     */
    signMessage: (
      path: string,
      message: string,
      coin = 'Bitcoin',
    ): Effect.Effect<{signature: string; address: string}, HardwareErrorType> =>
      Effect.gen(function* () {
        const result = yield* withTrezor('signMessage', () => trezorConnect.signMessage({path, coin, message}))
        return {
          signature: result.signature,
          address: result.address,
        }
      }),
  }
}

// ============================================================================
// Ethereum Operations
// ============================================================================

/**
 * Creates Ethereum operations wrapper for Trezor.
 */
export const createTrezorEthereum = (trezorConnect: TrezorConnectMultichain) => {
  const withTrezor = <T>(
    operation: string,
    fn: () => Promise<TrezorResponse<T>>,
  ): Effect.Effect<T, HardwareErrorType> =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: fn,
        catch: (error) => mapTrezorError(error, operation),
      })

      if (!response.success) {
        const failureResponse = response as {success: false; payload: {error: string; code?: string}}
        const errorMessage = extractTrezorError(failureResponse)
        const failureCode = extractTrezorFailureCode(failureResponse)
        return yield* Effect.fail(mapTrezorError(new Error(errorMessage), operation, failureCode))
      }

      return response.payload
    })

  return {
    /**
     * Gets an Ethereum extended public key.
     */
    getPublicKey: (
      path: string,
      verify = false,
    ): Effect.Effect<{publicKey: string; chainCode: string}, HardwareErrorType> =>
      Effect.gen(function* () {
        const result = yield* withTrezor('ethereumGetPublicKey', () =>
          trezorConnect.ethereumGetPublicKey({path, showOnTrezor: verify}),
        )
        return {
          publicKey: result.publicKey,
          chainCode: result.node.chain_code,
        }
      }),

    /**
     * Gets an Ethereum address.
     */
    getAddress: (path: string, verify = false): Effect.Effect<string, HardwareErrorType> =>
      Effect.gen(function* () {
        const result = yield* withTrezor('ethereumGetAddress', () =>
          trezorConnect.ethereumGetAddress({path, showOnTrezor: verify}),
        )
        return result.address
      }),

    /**
     * Signs an Ethereum transaction.
     */
    signTransaction: (path: string, tx: TrezorEthereumTx): Effect.Effect<TrezorEthereumSignature, HardwareErrorType> =>
      Effect.gen(function* () {
        const result = yield* withTrezor('ethereumSignTransaction', () =>
          trezorConnect.ethereumSignTransaction({
            path,
            transaction: tx,
          }),
        )
        return {
          v: result.v,
          r: result.r,
          s: result.s,
        }
      }),

    /**
     * Signs a personal message (EIP-191).
     */
    signMessage: (
      path: string,
      message: string,
      hex = false,
    ): Effect.Effect<{signature: string; address: string}, HardwareErrorType> =>
      Effect.gen(function* () {
        const result = yield* withTrezor('ethereumSignMessage', () =>
          trezorConnect.ethereumSignMessage({path, message, hex}),
        )
        return {
          signature: result.signature,
          address: result.address,
        }
      }),

    /**
     * Signs EIP-712 typed data.
     */
    signTypedData: (
      path: string,
      data: TrezorEIP712Data,
      metamaskV4Compat = true,
    ): Effect.Effect<{signature: string; address: string}, HardwareErrorType> =>
      Effect.gen(function* () {
        const result = yield* withTrezor('ethereumSignTypedData', () =>
          trezorConnect.ethereumSignTypedData({path, data, metamask_v4_compat: metamaskV4Compat}),
        )
        return {
          signature: result.signature,
          address: result.address,
        }
      }),
  }
}

// ============================================================================
// Solana Operations
// ============================================================================

/**
 * Creates Solana operations wrapper for Trezor.
 */
export const createTrezorSolana = (trezorConnect: TrezorConnectMultichain) => {
  const withTrezor = <T>(
    operation: string,
    fn: () => Promise<TrezorResponse<T>>,
  ): Effect.Effect<T, HardwareErrorType> =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: fn,
        catch: (error) => mapTrezorError(error, operation),
      })

      if (!response.success) {
        const failureResponse = response as {success: false; payload: {error: string; code?: string}}
        const errorMessage = extractTrezorError(failureResponse)
        const failureCode = extractTrezorFailureCode(failureResponse)
        return yield* Effect.fail(mapTrezorError(new Error(errorMessage), operation, failureCode))
      }

      return response.payload
    })

  return {
    /**
     * Gets a Solana public key.
     */
    getPublicKey: (path: string, verify = false): Effect.Effect<string, HardwareErrorType> =>
      Effect.gen(function* () {
        const result = yield* withTrezor('solanaGetPublicKey', () =>
          trezorConnect.solanaGetPublicKey({path, showOnTrezor: verify}),
        )
        return result.publicKey
      }),

    /**
     * Gets a Solana address.
     */
    getAddress: (path: string, verify = false): Effect.Effect<string, HardwareErrorType> =>
      Effect.gen(function* () {
        const result = yield* withTrezor('solanaGetAddress', () =>
          trezorConnect.solanaGetAddress({path, showOnTrezor: verify}),
        )
        return result.address
      }),

    /**
     * Signs a Solana transaction.
     */
    signTransaction: (
      path: string,
      serializedTx: string,
      tokenAccountsInfos?: Array<{
        baseAddress: string
        tokenProgram: string
        tokenMint: string
        tokenAccount: string
      }>,
    ): Effect.Effect<TrezorSolanaSignature, HardwareErrorType> =>
      Effect.gen(function* () {
        const result = yield* withTrezor('solanaSignTransaction', () =>
          trezorConnect.solanaSignTransaction({
            path,
            serializedTx,
            ...(tokenAccountsInfos ? {tokenAccountsInfos} : {}),
          }),
        )
        return {
          signature: result.signature,
        }
      }),
  }
}

// ============================================================================
// UTXO Variant Factories
// ============================================================================

/**
 * Creates Litecoin operations wrapper for Trezor.
 *
 * Delegates to `createTrezorBitcoin` with `coin: 'Litecoin'` defaults.
 */
export const createTrezorLitecoin = (trezorConnect: TrezorConnectMultichain) => {
  const btc = createTrezorBitcoin(trezorConnect)
  return {
    getPublicKey: (path: string, verify = false) => btc.getPublicKey(path, 'Litecoin', verify),
    getAddress: (path: string, verify = false, scriptType?: BitcoinScriptType) =>
      btc.getAddress(path, 'Litecoin', verify, scriptType),
    signTransaction: (
      inputs: readonly TrezorBitcoinInput[],
      outputs: readonly TrezorBitcoinOutput[],
      options?: Omit<TrezorBitcoinOptions, 'coin'>,
    ) => btc.signTransaction(inputs, outputs, {...options, coin: 'Litecoin'}),
    signMessage: (path: string, message: string) => btc.signMessage(path, message, 'Litecoin'),
  }
}

/**
 * Creates Dogecoin operations wrapper for Trezor.
 *
 * Delegates to `createTrezorBitcoin` with `coin: 'Dogecoin'` defaults.
 */
export const createTrezorDogecoin = (trezorConnect: TrezorConnectMultichain) => {
  const btc = createTrezorBitcoin(trezorConnect)
  return {
    getPublicKey: (path: string, verify = false) => btc.getPublicKey(path, 'Dogecoin', verify),
    getAddress: (path: string, verify = false, scriptType?: BitcoinScriptType) =>
      btc.getAddress(path, 'Dogecoin', verify, scriptType),
    signTransaction: (
      inputs: readonly TrezorBitcoinInput[],
      outputs: readonly TrezorBitcoinOutput[],
      options?: Omit<TrezorBitcoinOptions, 'coin'>,
    ) => btc.signTransaction(inputs, outputs, {...options, coin: 'Dogecoin'}),
    signMessage: (path: string, message: string) => btc.signMessage(path, message, 'Dogecoin'),
  }
}

/**
 * Creates Bitcoin Cash operations wrapper for Trezor.
 *
 * Delegates to `createTrezorBitcoin` with `coin: 'Bcash'` defaults.
 */
export const createTrezorBitcoinCash = (trezorConnect: TrezorConnectMultichain) => {
  const btc = createTrezorBitcoin(trezorConnect)
  return {
    getPublicKey: (path: string, verify = false) => btc.getPublicKey(path, 'Bcash', verify),
    getAddress: (path: string, verify = false, scriptType?: BitcoinScriptType) =>
      btc.getAddress(path, 'Bcash', verify, scriptType),
    signTransaction: (
      inputs: readonly TrezorBitcoinInput[],
      outputs: readonly TrezorBitcoinOutput[],
      options?: Omit<TrezorBitcoinOptions, 'coin'>,
    ) => btc.signTransaction(inputs, outputs, {...options, coin: 'Bcash'}),
    signMessage: (path: string, message: string) => btc.signMessage(path, message, 'Bcash'),
  }
}

export type TrezorBitcoin = ReturnType<typeof createTrezorBitcoin>
export type TrezorEthereum = ReturnType<typeof createTrezorEthereum>
export type TrezorSolana = ReturnType<typeof createTrezorSolana>
export type TrezorLitecoin = ReturnType<typeof createTrezorLitecoin>
export type TrezorDogecoin = ReturnType<typeof createTrezorDogecoin>
export type TrezorBitcoinCash = ReturnType<typeof createTrezorBitcoinCash>
