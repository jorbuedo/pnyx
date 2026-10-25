/**
 * Wallet error types using Effect TaggedError pattern.
 *
 * @module
 */

import {Data} from 'effect'

/**
 * Base wallet error.
 */
export class WalletError extends Data.TaggedError('WalletError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Wallet not found error.
 */
export class WalletNotFoundError extends Data.TaggedError('WalletNotFoundError')<{
  readonly groupId: string
}> {}

/**
 * Account not found error.
 */
export class AccountNotFoundError extends Data.TaggedError('AccountNotFoundError')<{
  readonly accountId: string
}> {}

/**
 * Wallet creation error.
 */
export class WalletCreationError extends Data.TaggedError('WalletCreationError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Insufficient funds error.
 */
export class InsufficientFundsError extends Data.TaggedError('InsufficientFundsError')<{
  readonly required: bigint
  readonly available: bigint
}> {}

/**
 * Derivation error.
 */
export class DerivationError extends Data.TaggedError('DerivationError')<{
  readonly message: string
  readonly path?: string
}> {}

/**
 * Sync error.
 */
export class SyncError extends Data.TaggedError('SyncError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Storage error.
 */
export class StorageError extends Data.TaggedError('StorageError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Signing error for CIP-8 operations.
 */
export class SigningError extends Data.TaggedError('SigningError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Verification error for CIP-8 operations.
 */
export class VerificationError extends Data.TaggedError('VerificationError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Address discovery error.
 */
export class AddressDiscoveryError extends Data.TaggedError('AddressDiscoveryError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Invalid mnemonic error.
 *
 * `cause` carries the underlying failure (typically a `VaultError` from
 * the credential vault, or the legacy thrown value from
 * `decryptWithPassword`). Threaded so the Sentry breadcrumb in
 * `wallet-credential-store.logDecryptError` can serialize the original
 * native error code + message — without it, every event lands with
 * `causeName: null, causeMessage: null, causeCode: null` (observed on
 * an upstream Sentry issue) and we lose the only telemetry signal we have for
 * tracking new keystore failure shapes.
 */
export class InvalidMnemonicError extends Data.TaggedError('InvalidMnemonicError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * The wallet's seed material exists on this device but can no longer be
 * decrypted by it.
 *
 * Raised on the enclave-scheme path when the OS biometric/passcode prompt
 * succeeds but the underlying decrypt fails because the keystore key has
 * been invalidated (Android `KeyPermanentlyInvalidatedException`, AES-GCM
 * tag mismatch, post-OS-upgrade TEE invalidation; iOS `errSecAuthFailed`,
 * lockout). Distinct from {@link InvalidMnemonicError} because no amount
 * of prompting will fix the state — the only recovery is to re-import the
 * wallet from its recovery phrase.
 */
export class KeyMaterialUnavailableError extends Data.TaggedError('KeyMaterialUnavailableError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Transaction CBOR parsing error.
 */
export class TransactionParseError extends Data.TaggedError('TransactionParseError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Base provider error.
 */
export class ProviderError extends Data.TaggedError('ProviderError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Error when provider for a chain is not found.
 */
export class ProviderNotFoundError extends Data.TaggedError('ProviderNotFoundError')<{
  readonly chainId: string
}> {
  get message(): string {
    return `Provider not found for chain: ${this.chainId}`
  }
}

/**
 * Error when network request fails.
 */
export class ProviderNetworkError extends Data.TaggedError('ProviderNetworkError')<{
  readonly message: string
  readonly chainId?: string
  readonly statusCode?: number
  readonly cause?: unknown
}> {}
