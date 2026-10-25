/**
 * Bitcoin Ledger app support.
 *
 * Provides Effect-based interface for Bitcoin Ledger app operations.
 * Requires @ledgerhq/hw-app-btc to be installed.
 *
 * @module
 */

import BtcAppModule from '@ledgerhq/hw-app-btc'
import {AppClient} from '@ledgerhq/hw-app-btc/lib/newops/appClient'
import {Effect} from 'effect'
import {HardwareError, type HardwareErrorType} from '../../types'
import {bytesToHex} from '../../utils'
import {mapLedgerError} from '../errors'
import type {LedgerTransport} from '../types'

// ============================================================================
// Types
// ============================================================================

/**
 * Bitcoin address types.
 */
export const BitcoinAddressFormat = {
  /** Legacy P2PKH addresses (1...) */
  LEGACY: 'legacy',
  /** SegWit P2SH-P2WPKH addresses (3...) */
  SEGWIT: 'p2sh',
  /** Native SegWit bech32 addresses (bc1q...) */
  NATIVE_SEGWIT: 'bech32',
  /** Taproot bech32m addresses (bc1p...) */
  TAPROOT: 'bech32m',
} as const

export type BitcoinAddressFormat = (typeof BitcoinAddressFormat)[keyof typeof BitcoinAddressFormat]

/**
 * Bitcoin network type.
 */
export type BitcoinNetwork = 'mainnet' | 'testnet'

/**
 * Extended public key response.
 */
export type BitcoinExtendedPublicKey = {
  /** Public key hex */
  readonly publicKey: string
  /** Chain code hex */
  readonly chainCode: string
  /** Bitcoin address (if requested) */
  readonly address?: string
}

/**
 * Wallet policy descriptor templates.
 */
export const WalletPolicyTemplate = {
  /** Legacy P2PKH: pkh(@0/**) */
  LEGACY: 'pkh(@0/**)',
  /** Nested SegWit P2SH-P2WPKH: sh(wpkh(@0/**)) */
  NESTED_SEGWIT: 'sh(wpkh(@0/**))',
  /** Native SegWit P2WPKH: wpkh(@0/**) */
  NATIVE_SEGWIT: 'wpkh(@0/**)',
  /** Taproot P2TR: tr(@0/**) */
  TAPROOT: 'tr(@0/**)',
} as const

export type WalletPolicyTemplate = (typeof WalletPolicyTemplate)[keyof typeof WalletPolicyTemplate]

/**
 * Wallet policy for PSBT signing.
 */
export type BitcoinWalletPolicy = {
  /** Policy name (displayed on device) */
  readonly name: string
  /** Descriptor template */
  readonly descriptorTemplate: WalletPolicyTemplate | string
  /** Key information */
  readonly keys: readonly {
    /** Master fingerprint (4 bytes hex) */
    readonly masterFingerprint: string
    /** Extended public key (xpub) */
    readonly xpub: string
  }[]
}

/**
 * BIP-32 derivation entry for a single wallet address.
 *
 * Keys in `knownAddressDerivations` are the hex-encoded scriptPubKey hash
 * (produced by @ledgerhq/psbtv2's `extractHashFromScriptPubKey`) — which for
 * P2WPKH is the 20-byte HASH160 of the compressed pubkey, in hex.
 */
export type BitcoinAddressDerivation = {
  /** 33-byte compressed pubkey at this path */
  readonly pubkey: Uint8Array
  /** BIP-32 path components; hardened segments have the 0x80000000 bit set */
  readonly path: readonly number[]
}

/**
 * Map from scriptPubKey-hash (hex) to derivation data for wallet-owned addresses.
 *
 * Required by `signPsbtBuffer` (hw-app-btc ≥ 10.18) so the Ledger library can
 * populate missing BIP-32 derivation fields for inputs and outputs that belong
 * to the signing wallet (e.g. change outputs).
 */
export type BitcoinKnownAddressDerivations = ReadonlyMap<string, BitcoinAddressDerivation>

/**
 * PSBT signing options.
 */
export type BitcoinPsbtSigningOptions = {
  /** Derivation paths for inputs (matching PSBT input order) */
  readonly inputPaths: readonly string[]
  /** Map from scriptPubKey-hash (hex) to derivation data. Required. */
  readonly knownAddressDerivations: BitcoinKnownAddressDerivations
  /** Display transaction on device */
  readonly displayTransaction?: boolean
  /** Wallet policy for signing */
  readonly walletPolicy?: BitcoinWalletPolicy
  /** HMAC for registered wallet (returned from registerWallet) */
  readonly walletHmac?: Uint8Array
  /** Whether this is a default wallet (no registration needed) */
  readonly isDefaultWallet?: boolean
}

/**
 * PSBT signing result.
 */
export type BitcoinPsbtSigningResult = {
  /** Signed PSBT bytes */
  readonly signedPsbt: Uint8Array
  /** Individual signatures for each input */
  readonly signatures: readonly {
    readonly inputIndex: number
    readonly signature: Uint8Array
    readonly publicKey: Uint8Array
  }[]
}

/**
 * Wallet registration result.
 */
export type WalletRegistrationResult = {
  /** Wallet ID (32 bytes) */
  readonly walletId: Uint8Array
  /** HMAC for wallet operations (32 bytes) */
  readonly walletHmac: Uint8Array
}

// ============================================================================
// App Instance Management
// ============================================================================

/**
 * Bitcoin app interface matching @ledgerhq/hw-app-btc v10.x (Btc class).
 *
 * Note: getMasterFingerprint and signPsbt are NOT on the Btc class.
 * Use AppClient for getMasterFingerprint, and Btc.signPsbtBuffer for PSBT signing.
 */
type BitcoinApp = {
  getWalletPublicKey(
    path: string,
    options?: {verify?: boolean; format?: string},
  ): Promise<{publicKey: string; chainCode: string; bitcoinAddress: string}>
  signMessage(path: string, messageHex: string): Promise<{v: number; r: string; s: string}>
  splitTransaction(transactionHex: string, ...args: unknown[]): unknown
  createPaymentTransaction(args: unknown): Promise<string>
  signPsbtBuffer(
    psbt: Buffer,
    opts: {
      finalizePsbt: boolean
      accountPath: string
      addressFormat: string
      knownAddressDerivations: Map<string, {pubkey: Buffer; path: number[]}>
    },
  ): Promise<{psbt: Buffer; tx?: string}>
}

/**
 * Convert the public `BitcoinKnownAddressDerivations` (ReadonlyMap of Uint8Array pubkeys)
 * to the shape `@ledgerhq/hw-app-btc`'s `signPsbtBuffer` expects
 * (mutable Map of Buffer pubkeys).
 */
const toLedgerKnownAddressDerivations = (
  map: BitcoinKnownAddressDerivations,
): Map<string, {pubkey: Buffer; path: number[]}> => {
  const out = new Map<string, {pubkey: Buffer; path: number[]}>()
  for (const [key, entry] of map) {
    out.set(key, {pubkey: Buffer.from(entry.pubkey), path: [...entry.path]})
  }
  return out
}

/**
 * Configuration for Bitcoin Ledger app variants.
 *
 * Allows the same app to be used for Bitcoin, Litecoin, Dogecoin, and Bitcoin Cash
 * by passing chain-specific parameters.
 */
export type BitcoinAppConfig = {
  /** Currency name passed to the app constructor (e.g., 'bitcoin', 'litecoin', 'dogecoin', 'bitcoin_cash') */
  readonly currency?: string
  /** Additional flags for transaction signing (e.g., ['abc'] for Bitcoin Cash) */
  readonly additionals?: readonly string[]
  /** Signature hash type override (e.g., 0x41 for Bitcoin Cash SIGHASH_FORKID) */
  readonly sigHashType?: number
}

/**
 * Creates a Bitcoin app instance from a transport.
 */
const createBtcAppInstance = (transport: unknown, currency?: string): BitcoinApp => {
  const BtcApp = BtcAppModule as unknown as {new (args: {transport: unknown; currency?: string}): BitcoinApp}
  return new BtcApp({transport, ...(currency ? {currency} : {})})
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Creates a Bitcoin Ledger app wrapper.
 *
 * @param transport - Ledger transport
 * @param config - Optional chain-specific configuration for UTXO variants
 * @returns Bitcoin app operations
 */
export const createBitcoinLedgerApp = (transport: LedgerTransport, config?: BitcoinAppConfig) => {
  let app: BitcoinApp | null = null
  let client: InstanceType<typeof AppClient> | null = null

  /** Currencies that use the new Bitcoin app protocol (v2.1+) via AppClient. */
  const NEW_PROTOCOL_CURRENCIES = ['bitcoin', 'bitcoin_testnet', 'bitcoin_regtest', 'qtum']
  const isNewProtocol = !config?.currency || NEW_PROTOCOL_CURRENCIES.includes(config.currency)

  const getApp = (): BitcoinApp => {
    if (app) return app
    app = createBtcAppInstance(transport, config?.currency)
    return app
  }

  const getAppClient = (): InstanceType<typeof AppClient> => {
    if (client) return client
    if (!isNewProtocol) {
      throw new Error('AppClient is only available for new protocol currencies (Bitcoin app v2.1+)')
    }
    // AppClient expects Transport from @ledgerhq/hw-transport, which our LedgerTransport is compatible with
    client = new AppClient(transport as never)
    return client
  }

  return {
    /**
     * Gets an extended public key at the given derivation path.
     *
     * @param path - Derivation path (e.g., "m/84'/0'/0'")
     * @param verify - Display address on device for verification
     * @param format - Address format (legacy, p2sh, bech32, bech32m)
     */
    getExtendedPublicKey: (
      path: string,
      verify = false,
      format: BitcoinAddressFormat = BitcoinAddressFormat.NATIVE_SEGWIT,
    ): Effect.Effect<BitcoinExtendedPublicKey, HardwareErrorType> =>
      Effect.tryPromise({
        try: async () => {
          const btcApp = getApp()
          const result = await btcApp.getWalletPublicKey(path, {verify, format})
          return {
            publicKey: result.publicKey,
            chainCode: result.chainCode,
            address: result.bitcoinAddress,
          }
        },
        catch: (error) => mapLedgerError(error, 'get Bitcoin public key', 'Bitcoin'),
      }),

    /**
     * Gets a Bitcoin address at the given derivation path.
     *
     * @param path - Derivation path (e.g., "m/84'/0'/0'/0/0")
     * @param verify - Display address on device for verification
     * @param format - Address format
     */
    getAddress: (
      path: string,
      verify = false,
      format: BitcoinAddressFormat = BitcoinAddressFormat.NATIVE_SEGWIT,
    ): Effect.Effect<string, HardwareErrorType> =>
      Effect.gen(function* () {
        const btcApp = yield* Effect.try({
          try: () => getApp(),
          catch: (error) =>
            new HardwareError({
              message: `Failed to get Bitcoin app: ${error instanceof Error ? error.message : String(error)}`,
            }),
        })

        const result = yield* Effect.tryPromise({
          try: () => btcApp.getWalletPublicKey(path, {verify, format}),
          catch: (error) => mapLedgerError(error, 'get Bitcoin address', 'Bitcoin'),
        })

        return result.bitcoinAddress
      }),

    /**
     * Signs a message with a Bitcoin private key.
     *
     * @param path - Derivation path
     * @param message - Message to sign (hex encoded)
     */
    signMessage: (path: string, message: string): Effect.Effect<{r: string; s: string; v: number}, HardwareErrorType> =>
      Effect.tryPromise({
        try: async () => {
          const btcApp = getApp()
          const result = await btcApp.signMessage(path, message)
          return {r: result.r, s: result.s, v: result.v}
        },
        catch: (error) => mapLedgerError(error, 'sign Bitcoin message', 'Bitcoin'),
      }),

    /**
     * Signs a PSBT using `Btc.signPsbtBuffer` and returns the signed PSBT and finalized tx hex.
     *
     * This uses the Ledger library's built-in wallet policy creation and PSBT signing.
     * The accountPath is derived from the first input path if not provided via wallet policy.
     *
     * @param psbt - PSBT bytes (v0 format from @scure/btc-signer)
     * @param options - Signing options
     */
    signPsbt: (
      psbt: Uint8Array,
      options: BitcoinPsbtSigningOptions,
    ): Effect.Effect<BitcoinPsbtSigningResult, HardwareErrorType> =>
      Effect.tryPromise({
        try: async () => {
          const btcApp = getApp()

          // Derive account path from input paths for signPsbtBuffer
          const firstPath = options.inputPaths[0] ?? "m/84'/0'/0'/0/0"
          const accountPath = firstPath.split('/').slice(0, 4).join('/')

          // Infer address format from path purpose
          const purpose = accountPath.replace(/^m\//, '').split('/')[0]
          let addressFormat: string | undefined
          switch (purpose) {
            case "44'":
              addressFormat = 'legacy'
              break
            case "49'":
              addressFormat = 'p2sh'
              break
            case "86'":
              addressFormat = 'bech32m'
              break
            default:
              addressFormat = 'bech32'
              break
          }

          // Use signPsbtBuffer which handles wallet policy creation internally
          const result = await btcApp.signPsbtBuffer(Buffer.from(psbt), {
            finalizePsbt: false,
            accountPath,
            addressFormat,
            knownAddressDerivations: toLedgerKnownAddressDerivations(options.knownAddressDerivations),
          })

          // Return the signed PSBT (signatures are embedded in the PSBT by signPsbtBuffer)
          return {
            signedPsbt: new Uint8Array(result.psbt),
            signatures: [],
          }
        },
        catch: (error) => mapLedgerError(error, 'sign Bitcoin PSBT', 'Bitcoin'),
      }),

    /**
     * Signs a PSBT and returns the finalized transaction hex.
     *
     * This is the preferred method for signing — it delegates entirely to the Ledger
     * library's `signPsbtBuffer`, which handles wallet policy creation, signing,
     * finalization, and transaction extraction internally.
     *
     * @param psbt - PSBT bytes (v0 format)
     * @param options - Optional account path and address format hints
     * @returns Finalized transaction hex string
     */
    signPsbtAndFinalize: (
      psbt: Uint8Array,
      options: {
        accountPath: string
        addressFormat: BitcoinAddressFormat
        knownAddressDerivations: BitcoinKnownAddressDerivations
      },
    ): Effect.Effect<string, HardwareErrorType> =>
      Effect.tryPromise({
        try: async () => {
          const btcApp = getApp()
          const result = await btcApp.signPsbtBuffer(Buffer.from(psbt), {
            finalizePsbt: true,
            accountPath: options.accountPath,
            addressFormat: options.addressFormat,
            knownAddressDerivations: toLedgerKnownAddressDerivations(options.knownAddressDerivations),
          })
          // finalizePsbt: true guarantees `tx` is present.
          if (!result.tx) throw new Error('signPsbtBuffer returned no tx despite finalizePsbt=true')
          return result.tx
        },
        catch: (error) => mapLedgerError(error, 'sign Bitcoin PSBT', 'Bitcoin'),
      }),

    /**
     * Gets the master fingerprint from the device.
     *
     * This is the fingerprint of the master key (first 4 bytes of hash160
     * of the master public key). Uses AppClient directly since the Btc
     * class does not expose this method.
     *
     * Only available for new protocol currencies (Bitcoin app v2.1+).
     */
    getMasterFingerprint: (): Effect.Effect<string, HardwareErrorType> =>
      Effect.tryPromise({
        try: async () => {
          const appClient = getAppClient()
          const fingerprint = await appClient.getMasterFingerprint()
          return bytesToHex(new Uint8Array(fingerprint))
        },
        catch: (error) => mapLedgerError(error, 'get Bitcoin master fingerprint', 'Bitcoin'),
      }),

    /**
     * Splits a raw transaction hex into Ledger's internal format.
     *
     * Used by `createPaymentTransaction` for UTXO signing.
     *
     * @param transactionHex - Raw transaction hex
     * @param isSegwitSupported - Parse segwit witness data (pass true for modern transactions)
     */
    splitTransaction: (
      transactionHex: string,
      isSegwitSupported?: boolean,
    ): Effect.Effect<unknown, HardwareErrorType> =>
      Effect.tryPromise({
        try: async () => {
          const btcApp = getApp()
          return await btcApp.splitTransaction(transactionHex, isSegwitSupported)
        },
        catch: (error) => mapLedgerError(error, 'split Bitcoin transaction', 'Bitcoin'),
      }),

    /**
     * Creates and signs a payment transaction using the legacy API.
     *
     * This is a legacy API used by chains signers for UTXO signing.
     * Prefer PSBT signing for new code.
     *
     * @param args - Arguments passed directly to the Ledger Bitcoin app
     */
    createPaymentTransaction: (args: {
      readonly inputs: readonly [splitTx: unknown, outputIndex: number, redeemScript?: string, sequence?: number][]
      readonly associatedKeysets: readonly string[]
      readonly outputScriptHex: string
      readonly lockTime?: number
      readonly sigHashType?: number
      readonly segwit?: boolean
      readonly additionals?: readonly string[]
      readonly expiryHeight?: Uint8Array
    }): Effect.Effect<string, HardwareErrorType> =>
      Effect.tryPromise({
        try: async () => {
          const btcApp = getApp()
          const mergedArgs = {
            ...args,
            // Apply config defaults for UTXO variants
            ...(config?.sigHashType !== undefined && args.sigHashType === undefined
              ? {sigHashType: config.sigHashType}
              : {}),
            ...(config?.additionals && !args.additionals?.length ? {additionals: [...config.additionals]} : {}),
          }
          return await btcApp.createPaymentTransaction(mergedArgs)
        },
        catch: (error) => mapLedgerError(error, 'create Bitcoin payment transaction', 'Bitcoin'),
      }),
  }
}

export type BitcoinLedgerApp = ReturnType<typeof createBitcoinLedgerApp>
