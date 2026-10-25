/**
 * Signer package for unified signing abstractions.
 *
 * Provides shared signer error types. Generic key derivation is available
 * via `@pnyx/signer/chains`.
 *
 * @module
 */

export type {SignerInfo, WalletSignerError} from './types.js'
export {
  SignerError,
  SignerNotConnectedError,
  SignerTimeoutError,
  SignerUserRejectedError,
} from './types.js'
