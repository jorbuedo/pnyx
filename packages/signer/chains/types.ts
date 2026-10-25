/**
 * Shared types for multi-chain signers.
 *
 * Each chain has its own signer interface with chain-appropriate methods.
 * This module provides shared error types and signer metadata common to all chains.
 *
 * @module
 */

import {Data} from 'effect'

// ============================================================================
// Errors
// ============================================================================

/**
 * General chain signing error.
 */
export class ChainSignerError extends Data.TaggedError('ChainSignerError')<{
  readonly message: string
  readonly chain: string
  readonly cause?: unknown
}> {}

/**
 * User rejected the signing operation.
 */
export class ChainSignerUserRejectedError extends Data.TaggedError('ChainSignerUserRejectedError')<{
  readonly message: string
  readonly chain: string
}> {}

/**
 * Hardware device not connected or communication failed.
 */
export class ChainSignerNotConnectedError extends Data.TaggedError('ChainSignerNotConnectedError')<{
  readonly chain: string
  readonly deviceType: string
}> {}

/**
 * Signing operation timed out.
 */
export class ChainSignerTimeoutError extends Data.TaggedError('ChainSignerTimeoutError')<{
  readonly message: string
  readonly chain: string
  readonly timeoutMs: number
}> {}

/**
 * Union of all chain signer error types.
 */
export type ChainSignerErrorType =
  | ChainSignerError
  | ChainSignerUserRejectedError
  | ChainSignerNotConnectedError
  | ChainSignerTimeoutError

// ============================================================================
// Signer Metadata
// ============================================================================

/**
 * Supported chain identifiers for signing.
 */
export type ChainId = 'cardano' | 'midnight'

/**
 * Information about a chain signer.
 */
export type ChainSignerInfo = {
  readonly type: 'mnemonic' | 'private-key'
  readonly chain: ChainId
  readonly id: string
}
