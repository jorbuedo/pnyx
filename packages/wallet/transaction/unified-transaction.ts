/**
 * Unified transaction types for multi-chain transaction history.
 *
 * Provides a normalized view of transactions across all supported blockchain
 * types, combining Cardano-specific classifications with generic multi-chain
 * and EVM-specific fields.
 *
 * @module
 */

import type {ChainId, TransactionDirection, TransactionStatus} from '../types.js'

// ============================================================================
// Constants
// ============================================================================

/**
 * Asset ID used for the native/primary token of any chain in asset delta arrays
 * and portfolio data (e.g. ADA for Cardano, ETH for Ethereum).
 *
 * Both the tx-context-analyzer and upstream portfolio APIs use `'.'`
 * to identify the chain's native asset. All UI code should compare against
 * this constant rather than using a string literal.
 */
export const PRIMARY_TOKEN_ID = '.'

// ============================================================================
// Transaction Type
// ============================================================================

/**
 * Transaction type — covers Cardano's complete operation classification
 * plus generic multi-chain types.
 */
export type TransactionType =
  // Basic direction-based
  | 'sent'
  | 'received'
  | 'self'
  | 'multi'
  // Generic multi-chain
  | 'transfer'
  | 'claim'
  | 'approval'
  | 'approvalRevoke'
  // Staking
  | 'stakeRegistration'
  | 'stakeDeregistration'
  | 'stakeDelegation'
  | 'stakeUndelegation'
  // Pools
  | 'poolRegistration'
  | 'poolRetirement'
  // DeFi
  | 'swap'
  | 'swapCreated'
  | 'swapResolved'
  | 'swapCancel'
  | 'withdrawal'
  // Payment card
  | 'cardWithdrawal'
  // Smart contracts
  | 'smartContract'
  | 'collateralCreation'
  // Token operations
  | 'mint'
  | 'burn'
  | 'nft'
  | 'nightRedemption'
  // Governance (Cardano CIP-1694)
  | 'voteDelegation'
  | 'drepRegistration'
  | 'drepDeregistration'
  | 'drepUpdate'
  | 'stakeAndVoteDelegation'
  | 'stakeRegistrationAndDelegation'
  | 'stakeVoteRegistrationAndDelegation'
  | 'voteRegistrationAndDelegation'
  | 'committeeHotAuth'
  | 'committeeColdResign'
  | 'genesisKeyDelegation'
  | 'moveInstantaneousRewards'
  // Fallback
  | 'unknown'

/**
 * Runtime constants for {@link TransactionType} values.
 *
 * Use these instead of string literals when comparing transaction types.
 */
export const TransactionTypes = {
  sent: 'sent',
  received: 'received',
  self: 'self',
  multi: 'multi',
  transfer: 'transfer',
  claim: 'claim',
  approval: 'approval',
  approvalRevoke: 'approvalRevoke',
  stakeRegistration: 'stakeRegistration',
  stakeDeregistration: 'stakeDeregistration',
  stakeDelegation: 'stakeDelegation',
  stakeUndelegation: 'stakeUndelegation',
  poolRegistration: 'poolRegistration',
  poolRetirement: 'poolRetirement',
  swap: 'swap',
  swapCreated: 'swapCreated',
  swapResolved: 'swapResolved',
  swapCancel: 'swapCancel',
  withdrawal: 'withdrawal',
  smartContract: 'smartContract',
  collateralCreation: 'collateralCreation',
  mint: 'mint',
  burn: 'burn',
  nft: 'nft',
  nightRedemption: 'nightRedemption',
  voteDelegation: 'voteDelegation',
  drepRegistration: 'drepRegistration',
  drepDeregistration: 'drepDeregistration',
  drepUpdate: 'drepUpdate',
  stakeAndVoteDelegation: 'stakeAndVoteDelegation',
  stakeRegistrationAndDelegation: 'stakeRegistrationAndDelegation',
  stakeVoteRegistrationAndDelegation: 'stakeVoteRegistrationAndDelegation',
  voteRegistrationAndDelegation: 'voteRegistrationAndDelegation',
  committeeHotAuth: 'committeeHotAuth',
  committeeColdResign: 'committeeColdResign',
  genesisKeyDelegation: 'genesisKeyDelegation',
  moveInstantaneousRewards: 'moveInstantaneousRewards',
  cardWithdrawal: 'cardWithdrawal',
  unknown: 'unknown',
} as const satisfies Record<TransactionType, TransactionType>

// ============================================================================
// Token & NFT Transfers
// ============================================================================

/**
 * Simple token transfer within a transaction.
 *
 * Used for backward compatibility with StoredTransaction metadata.
 */
export type TokenTransfer = {
  readonly id: string
  readonly symbol?: string | undefined
  readonly amount: string
  readonly decimals?: number | undefined
}

/**
 * Rich token transfer with full metadata from multi-chain providers.
 */
export type RichTokenTransfer = {
  readonly assetId: string
  readonly symbol: string
  readonly name: string
  readonly amount: bigint
  readonly decimals: number
  readonly from: string
  readonly to: string
  readonly contractAddress?: string | undefined
  readonly logoUrl?: string | undefined
}

/**
 * NFT transfer within a transaction.
 */
export type NftTransfer = {
  readonly contractAddress: string
  readonly tokenId: string
  readonly name?: string | undefined
  readonly imageUrl?: string | undefined
  readonly from: string
  readonly to: string
}

// ============================================================================
// Transaction Data
// ============================================================================

/**
 * Unified transaction representation for all chains.
 *
 * Combines Cardano-specific fields with EVM/multi-chain fields into a single
 * type used throughout the wallet — from the package layer (services, adapters)
 * to the UI layer (screens, hooks, components).
 */
export type TransactionData = {
  /** Transaction hash */
  readonly hash: string

  /** Chain this transaction belongs to */
  readonly chain: ChainId

  /** Transaction status */
  readonly status: TransactionStatus

  /** Transaction direction relative to wallet */
  readonly direction: TransactionDirection

  /** Transaction type */
  readonly type: TransactionType

  /** Unix timestamp in seconds */
  readonly timestamp?: number | undefined

  /** Unix timestamp (seconds) when the transaction was submitted to the network */
  readonly submittedAt?: number | undefined

  /** Block number */
  readonly blockNumber?: number | undefined

  /** Block hash */
  readonly blockHash?: string | undefined

  /** Sender address */
  readonly from: string

  /** Recipient address */
  readonly to?: string | undefined

  /** Native currency value transferred */
  readonly value: bigint

  /** Transaction fee paid */
  readonly fee?: bigint | undefined

  /** Number of confirmations */
  readonly confirmations?: number | undefined

  /** Memo/note */
  readonly memo?: string | undefined

  /** Icon URL for the primary asset involved in this transaction */
  readonly iconUrl?: string | undefined

  /** Symbol of the primary asset (e.g., "ETH", "ADA", "USDT") */
  readonly assetSymbol?: string | undefined

  /** Name of the primary asset */
  readonly assetName?: string | undefined

  /** Decimals of the primary asset */
  readonly assetDecimals?: number | undefined

  /** USD price per unit of the primary asset */
  readonly assetPrice?: number | undefined

  /** Token ID for metadata lookups (e.g., Cardano: `{policyId}.{assetNameHex}`) */
  readonly tokenId?: string | undefined

  /** Simple token transfers (from StoredTransaction metadata) */
  readonly tokens?: readonly TokenTransfer[] | undefined

  /** Rich token transfers (from multi-chain providers) */
  readonly tokenTransfers?: readonly RichTokenTransfer[] | undefined

  /** NFT transfers */
  readonly nftTransfers?: readonly NftTransfer[] | undefined

  /**
   * Indexed list flag: the tx moved at least one NFT. Copied from
   * {@link TxListItem.hasNft} on the list projection path so filters work
   * without loading `detailJson`.
   */
  readonly hasNft?: boolean | undefined

  // -- EVM-specific fields --

  /** Raw transaction data (hex) */
  readonly data?: string | undefined

  /** Transaction nonce (for account-based chains) */
  readonly nonce?: number | undefined

  /** Gas price */
  readonly gasPrice?: bigint | undefined

  /** Gas used */
  readonly gasUsed?: bigint | undefined

  /** Gas limit */
  readonly gasLimit?: bigint | undefined

  /** Contract address if this is a contract creation */
  readonly contractAddress?: string | undefined

  /** Method name if this is a contract call */
  readonly methodName?: string | undefined

  /** Error message if transaction failed */
  readonly errorMessage?: string | undefined

  /** Signed primary asset delta (bigint as string) for wallet-aware display */
  readonly primaryAssetDelta?: string | undefined

  /** Number of additional non-zero asset deltas beyond the primary */
  readonly additionalAssetCount?: number | undefined

  /** All per-asset deltas for the wallet (for detail view breakdown) */
  readonly assetDeltas?: readonly {readonly assetId: string; readonly delta: string}[] | undefined

  /**
   * Flat list of every asset id touched by this tx (Cardano native assets,
   * EVM/Solana token contracts, ADA / native chain coin when relevant).
   *
   * Populated by both the list projection (`txListItemToTransactionData`)
   * and the detail mapper (`mapStoredTransactionToTransactionData`) so the
   * per-asset filter at `filter-pipeline.ts` works regardless of which path
   * produced the row — `assetDeltas` and `tokenTransfers` are detail-only
   * shapes that the list projection drops.
   */
  readonly assetIds?: readonly string[] | undefined

  /** External parties and their amounts (for "Other parties" section) */
  readonly otherParties?:
    | readonly {
        readonly address: string
        readonly coin: string
        readonly assets?: readonly {readonly assetId: string; readonly amount: string}[]
      }[]
    | undefined

  /** Additional chain-specific metadata */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined

  // -- Swap-specific fields --

  /** Asset sent in a swap (from side) */
  readonly swapFromAsset?: SwapAssetInfo | undefined

  /** Asset received in a swap (to side) */
  readonly swapToAsset?: SwapAssetInfo | undefined
}

/**
 * Asset info for one side of a swap transaction.
 */
export type SwapAssetInfo = {
  /** Raw amount (in smallest unit) */
  readonly amount: bigint
  /** Asset symbol (e.g. "USDC") */
  readonly symbol: string
  /** Decimal places */
  readonly decimals: number
  /** Icon URL */
  readonly iconUrl?: string | undefined
}

// ============================================================================
// Transaction Filter & History Types
// ============================================================================

/**
 * Filter options for transaction history.
 */
export type TransactionFilter = {
  /** Filter by direction */
  readonly direction?: TransactionDirection | undefined

  /** Filter by type(s) */
  readonly type?: TransactionType | readonly TransactionType[] | undefined

  /** Filter by status */
  readonly status?: TransactionStatus | undefined

  /** Filter by chain */
  readonly chain?: ChainId | undefined

  /** Filter by start date */
  readonly startDate?: Date | undefined

  /** Filter by end date */
  readonly endDate?: Date | undefined

  /** Filter by minimum native value */
  readonly minAmount?: bigint | undefined

  /** Filter by maximum native value */
  readonly maxAmount?: bigint | undefined

  /** Search query (hash, address, token name/symbol) */
  readonly search?: string | undefined

  /** Filter by token ID or symbol */
  readonly token?: string | undefined

  /** Filter by asset ID (for rich token transfers) */
  readonly assetId?: string | undefined
}

/**
 * Backward-compatible alias for TransactionFilter.
 */
export type TransactionHistoryFilter = TransactionFilter

/**
 * Pagination options for transaction history.
 */
export type TransactionHistoryPagination = {
  /** Number of transactions to return */
  readonly limit?: number | undefined

  /** Number of transactions to skip */
  readonly offset?: number | undefined

  /** Cursor for cursor-based pagination */
  readonly cursor?: string | undefined
}

/**
 * Response from transaction history query.
 */
export type TransactionHistoryResponse = {
  /** List of transactions */
  readonly transactions: readonly TransactionData[]

  /** Whether there are more transactions to load */
  readonly hasMore: boolean

  /** Cursor for next page (if using cursor-based pagination) */
  readonly cursor?: string | undefined

  /** Total number of transactions (if known) */
  readonly total?: number | undefined
}
