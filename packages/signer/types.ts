/**
 * Signer types — backward-compatible re-exports.
 *
 * The canonical types live in `chains/types.ts` (ChainSignerError, etc.).
 * This module provides aliases for consumers that still import from
 * `@pnyx/signer`.
 *
 * @module
 */

// Error union
export type {ChainSignerErrorType as WalletSignerError, ChainSignerInfo as SignerInfo} from './chains/types.js'
// Error types (re-export classes so they work as values + types)
export {
  ChainSignerError as SignerError,
  ChainSignerNotConnectedError as SignerNotConnectedError,
  ChainSignerTimeoutError as SignerTimeoutError,
  ChainSignerUserRejectedError as SignerUserRejectedError,
} from './chains/types.js'
