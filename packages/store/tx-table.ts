/**
 * Transactions table — list-shaped, indexed, projection-friendly storage
 * for wallet transaction history.
 *
 * Distinct from {@link Store} (the KV interface), which remains the right
 * abstraction for blob data like wallet snapshots, sync checkpoints, and
 * preferences. Transaction history has order, filter, and projection
 * needs that KV can't satisfy without deserializing every row.
 *
 * Adapters:
 *  - {@link ExpoSQLiteTxTable}    – native (iOS / Android) via expo-sqlite
 *  - {@link IndexedDBTxTable}     – web / extension via IndexedDB
 *  - {@link MemoryTxTable}        – in-process for tests
 *
 * @module
 */

import {Context, type Effect} from 'effect'
import type {StoreErrors} from './errors.js'

/**
 * Schema version for the transactions table.
 *
 * Bumped whenever the row shape, column set, or indexes change. On open,
 * adapters compare against the stored value and DROP+RECREATE on mismatch.
 * Chain-sync repopulates on next mount. Snapshots/checkpoints in the KV
 * store are untouched.
 *
 * This is intentionally not a migration framework — the project ships
 * pre-launch and we wipe local data on schema bumps rather than maintain
 * forward/backward-compatible transforms.
 */
export const TX_TABLE_SCHEMA_VERSION = 1

/**
 * Classified transaction type — drives list-view label and icon at render.
 *
 * Stored as an opaque string at the storage layer (this package). The
 * canonical union of valid values lives in
 * `packages/wallet/transaction/unified-transaction.ts` as `TransactionType`
 * — 35+ values spanning direction, staking, governance, DeFi, NFTs,
 * etc. Mirroring it here would force every new tx type to update two
 * places and offer no extra safety; the SQL adapters treat it as a
 * TEXT column either way.
 *
 * Chain-specific syncs map their native tx shape onto one of these
 * *at write time*, so the list view can pick label and icon from
 * `type` + `direction` alone without parsing the detail blob. Labels
 * and icons remain pure render-time functions — if translations or
 * assets change, every stored row picks up the new display
 * automatically with no re-classification pass.
 */
export type TxType = string

export type TxStatus = 'pending' | 'confirmed' | 'failed'

export type TxDirection = 'sent' | 'received' | 'self'

/**
 * Identity reference for a chain wallet's transaction set.
 *
 * Mirrors `DataRef` in `@pnyx/wallet`; duplicated here so the store
 * package can stay free of wallet-package imports.
 */
export type TxRef = {
  readonly groupId: string
  readonly chainId: string
  readonly accountIndex: number
}

/**
 * A single row in the transactions table.
 *
 * Carries everything the activity list needs *and* an opaque `detailJson`
 * payload for the detail screen. The list view path projects only the
 * columns it needs ({@link TxListItem}) and never touches `detailJson`.
 */
export type TxRow = TxRef & {
  readonly hash: string

  /** Unix timestamp in seconds. Indexed for sort. `null` for unconfirmed pending txs without a known submit time. */
  readonly timestamp: number | null
  /** Unix timestamp (seconds) when this wallet first submitted the tx. Used for the "slow pending" badge. */
  readonly submittedAt: number | null
  readonly status: TxStatus
  readonly type: TxType
  readonly direction: TxDirection

  /** Native-token amount as a decimal string (chain-specific atomic unit awareness lives in callers). */
  readonly amount: string
  /** Fee paid as a decimal string. Optional — some chains don't surface fee at index time. */
  readonly fee: string | null

  /** Other party in a transfer (recipient for sent, sender for received). `null` for self / contract / staking ops. */
  readonly counterpartyAddress: string | null

  /** Signed primary-asset delta from the wallet's perspective (decimal string). */
  readonly primaryAssetDelta: string | null
  /** Count of additional non-zero asset deltas beyond the primary — drives the "+N more" label. */
  readonly additionalAssetCount: number
  /** True when the tx moved at least one NFT — drives the NFT filter on the per-asset screen without parsing detailJson. */
  readonly hasNft: boolean

  /** Primary asset ticker (e.g. "ADA", "ETH"). */
  readonly assetSymbol: string | null
  /** Primary asset decimals — used to format `amount` / `primaryAssetDelta`. */
  readonly assetDecimals: number | null
  /** Primary asset icon URL. Live `assetPrice` is fetched at render time, not stored. */
  readonly iconUrl: string | null
  /** Cardano-style `{policyId}.{assetNameHex}` or chain-specific token id; used for live price + metadata lookups. */
  readonly tokenId: string | null
  /** Contract address (EVM) — used for card-activity detection at list time. */
  readonly contractAddress: string | null

  /**
   * List-render subset of `metadata` (card row hints, pending amount override).
   * Stored as a JSON string. Typically `null` for non-card txs.
   * Full chain-specific metadata stays in {@link detailJson}.
   */
  readonly listMetaJson: string | null

  /**
   * Opaque chain-specific payload (inputs / outputs / certificates / full metadata).
   * Stored as a JSON string. Only the detail screen reads this; list view
   * queries omit the column.
   */
  readonly detailJson: string
}

/**
 * Projection used by {@link TxTable.list} — every column except `detailJson`.
 *
 * The detail blob is the heaviest field on the row and isn't needed to
 * render the activity list, so the list query omits it entirely. Callers
 * needing the full payload (detail screen) read via {@link TxTable.get}.
 */
export type TxListItem = Omit<TxRow, 'detailJson'>

/**
 * Query parameters for {@link TxTable.list}.
 *
 * Required filters (`groupId`, `chainId`, `accountIndex`) come from {@link TxRef};
 * everything else is optional. Results are returned sorted by `timestamp`
 * descending (newest first); pending rows with `timestamp: null` always
 * sort to the top.
 */
export type TxListQuery = TxRef & {
  /** Maximum rows to return. Omit for unbounded — only safe on small histories. */
  readonly limit?: number
  /** Skip the first N rows after the active sort/filter. Default 0. */
  readonly offset?: number
  /** Filter to a single status. */
  readonly status?: TxStatus
  /** Filter to a non-empty set of types. */
  readonly types?: ReadonlyArray<TxType>
  /** Only include rows with `timestamp > newerThan` (unix seconds). */
  readonly newerThan?: number
  /** Only include rows with `timestamp < olderThan` (unix seconds). */
  readonly olderThan?: number
}

/**
 * Transactions table interface.
 *
 * Methods take a {@link TxRef} (rather than a scoped sub-handle) so a
 * single table instance serves every (group, chain, account) tuple — the
 * underlying storage is partitioned by those columns + indexed.
 *
 * Writes:
 *  - `put` / `putMany` upsert by (group, chain, account, hash). Re-syncing
 *    a tx that already exists replaces the row; classification at write
 *    time may resolve previously-unknown fields (e.g. timestamp once the
 *    block confirms).
 *
 * Reads:
 *  - `list` projects to {@link TxListItem} (no detail blob). Always sorted
 *    by `timestamp` desc.
 *  - `get` returns the full {@link TxRow} including `detailJson`.
 *
 * Maintenance:
 *  - `prune` keeps the `keepCount` newest rows for the given ref and
 *    deletes the rest. Returns how many were removed.
 *  - `clear` removes every row for the given ref.
 *  - `close` releases the underlying database/connection.
 */
export type TxTable = {
  readonly put: (row: TxRow) => Effect.Effect<void, StoreErrors>
  readonly putMany: (rows: ReadonlyArray<TxRow>) => Effect.Effect<void, StoreErrors>
  readonly list: (query: TxListQuery) => Effect.Effect<ReadonlyArray<TxListItem>, StoreErrors>
  readonly get: (ref: TxRef, hash: string) => Effect.Effect<TxRow | null, StoreErrors>
  readonly prune: (ref: TxRef, keepCount: number) => Effect.Effect<number, StoreErrors>
  readonly clear: (ref: TxRef) => Effect.Effect<void, StoreErrors>
  readonly close: () => Effect.Effect<void, StoreErrors>
}

/**
 * Effect Service tag for dependency injection.
 */
export class TxTableService extends Context.Tag('TxTableService')<TxTableService, TxTable>() {}
