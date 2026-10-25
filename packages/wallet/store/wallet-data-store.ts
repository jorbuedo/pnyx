/**
 * Wallet data persistence store.
 *
 * Uses @pnyx/store for structured binary storage of wallet data
 * including UTXOs, balances, addresses, and transaction history.
 *
 * @module
 */

import type {AddressBranch, AddressListQuery, AddressRef, AddressRow, AddressTable} from '@pnyx/store/address-table'
import type {AssetListQuery, AssetRef, AssetRow, AssetsTable} from '@pnyx/store/assets-table'
import type {StoreErrors} from '@pnyx/store/errors'
import {type Store, StoreService} from '@pnyx/store/store'
import type {TxListItem, TxListQuery, TxRef, TxRow, TxTable} from '@pnyx/store/tx-table'
import type {UtxoListQuery, UtxoRef, UtxoRow, UtxoTable} from '@pnyx/store/utxo-table'
import {Context, Effect, Stream} from 'effect'
import type {ChainId, DerivativeInfo, Powers, WalletGroupId} from '../types.js'

/**
 * Stored UTXO format.
 *
 * `quantity` holds the primary-token amount as a decimal string (lovelace on
 * Cardano, satoshis on Bitcoin/BCH/LTC/DOGE). The name is intentionally
 * chain-neutral — this type is reused across every UTXO chain's snapshot.
 */
export type StoredUtxo = {
  readonly txHash: string // hex
  readonly txIndex: number
  readonly address: string // bech32 address
  /** Primary-token amount as a decimal string (lovelace / sats). */
  readonly quantity: string
  readonly assets: ReadonlyArray<{readonly id: string; readonly quantity: string}>
}

export type StoredBalances = {
  readonly primary: StoredBalance
  readonly secondary: ReadonlyArray<StoredBalance>
  readonly rewards?: {
    readonly available?: StoredBalance
  }
}

export type WalletSnapshot = {
  readonly version: number
  readonly groupId: WalletGroupId
  readonly chainId: ChainId
  /** Account index this snapshot belongs to. Defaults to 0 for backwards compat. */
  readonly accountIndex?: number
  readonly balances: StoredBalances
  readonly powers?: Powers
  readonly delegated?: {
    readonly voting?: {
      readonly txHash: string
      readonly epoch: number
      readonly slot: number
      readonly drepHash: string
      readonly drepType: 'addr_keyhash' | 'scripthash' | 'abstain' | 'no_confidence'
    }
    readonly staking?: {
      readonly txHash: string
      readonly epoch: number
      readonly slot: number
      readonly poolHash: string
    }
  }
  readonly registered?: {
    readonly staking?: {
      readonly txHash: string
      readonly epoch: number
      readonly slot: number
    }
  }
  readonly txCount?: number
  /** Newest-tx sync watermark for the Cardano rail's storage-first gate: the
   *  cheap "did anything change?" cursor persisted across sessions so a cold
   *  start's first sync can be watermark-gated too. See docs/CARDANO_DATA_SYNC.md. */
  readonly syncWatermark?: {readonly newestTxHash: string; readonly newestBlockHeight: number | null}
  /** Fingerprint of the address set the {@link syncWatermark} was established under.
   *
   *  ⚠️ **A watermark is only meaningful for the addresses that produced it.** It records
   *  "everything up to here has been fetched"; widening the address set makes that false
   *  without changing the newest transaction, so the gate reads "nothing changed" and the
   *  new addresses are never fetched. Absent means unknown coverage, which must be treated
   *  as not matching so the next sync refetches once. See docs/CARDANO_DATA_SYNC.md. */
  readonly syncCoverage?: string
  /** Last API-confirmed txCount. Stays unchanged when addPendingTransaction bumps txCount,
   *  so the sync loop can detect when the API catches up to the optimistic count. */
  readonly confirmedTxCount?: number
  /** True when only a partial (recent) tx sync was performed. Cleared after a full sync. */
  readonly partialSync?: boolean
  /** Bounded retry counter for reconciling an empty UTXO set against a confirmed
   *  on-chain tx. The indexer can report the new stake-key txCount before its utxos
   *  endpoint exposes the matching output, so a single fetch triggered by the txCount
   *  bump can return empty and then freeze (txCount matches → no re-fetch). Incremented
   *  on each suspicious empty fetch, reset to 0 once a non-empty fetch lands, and capped
   *  so a legitimately-empty wallet stops retrying. */
  readonly utxoReconcileAttempts?: number
}

export const WALLET_SNAPSHOT_VERSION = 6

/** Resume cursor for a single address-batch's history walk. */
export type TxBatchCursor = {
  readonly blockHash: string
  readonly txHash: string
}

/**
 * Transaction sync checkpoint.
 *
 * `batches` holds a per-address-batch resume cursor (keyed by a stable batch
 * key). A large wallet walks its history across many batches that finish at
 * different times; a single global cursor could only advance once every batch
 * had progressed, so an interrupted walk persisted nothing and re-walked from
 * genesis every launch. Per-batch cursors persist each batch's progress
 * independently. The top-level `blockHash`/`txHash` are retained for
 * back-compat (legacy single-cursor resume when `batches` is absent).
 */
export type TxCheckpoint = {
  readonly blockHash: string
  readonly txHash: string
  readonly txCount: number
  readonly batches?: Readonly<Record<string, TxBatchCursor>>
  /**
   * The highest block height whose transaction *refs* have been enumerated.
   *
   * ⚠️ **It has to live here because a stored row does not carry a height.** `TxRow` has no block
   * height and `TxListItem` omits `detailJson`, so deriving this from the store would mean parsing
   * every transaction's detail — which is why `afterBlockCursor` existed and was never used. The refs
   * a walk already receives carry `blockHeight`, so the walk records it as it goes.
   */
  readonly newestBlockHeight?: number
  /**
   * Whether the last walk enumerated to exhaustion **and** persisted every page.
   *
   * Both halves matter. Pages are persisted as they land, so an interrupted walk can leave the store
   * holding newer transactions while older ones are missing — and an incremental cursor would never
   * go back for them. A page whose write failed is the same hazard with a quieter cause. Either way
   * this stays `false` and the next run re-enumerates in full, which heals the gap.
   *
   * When it is `true`, "complete up to {@link newestBlockHeight}" holds inductively: a run only goes
   * incremental if the previous run was complete.
   */
  readonly complete?: boolean
  /**
   * When history was last reconciled against the chain (epoch ms), or absent if never.
   *
   * The incremental path asks only for blocks above a margin, so a rollback deeper than that margin
   * would never be noticed. The reconciliation pass re-reads Cardano's rollback bound and bounds how
   * long any such drift can persist. (It re-walked the *whole* account until 2026-08-27 — which on a
   * large account is a walk that cannot finish, so the drift was never bounded there at all.)
   */
  readonly fullWalkAt?: number
  /**
   * The lowest block height whose refs have been enumerated, exclusive — the bottom of the walk.
   *
   * ⚠️ **Written after every window, not at the end of a walk.** A history too large to enumerate in
   * one run is precisely the one whose progress has to survive the run, and recording it only at the
   * end meant a wallet that could never finish recorded nothing and restarted from the top forever.
   */
  readonly oldestEnumeratedHeight?: number
  /**
   * The height of the account's oldest transaction — the floor a backfill descends to.
   *
   * Read once, with an ascending `limit: 1` query. Without it a walk cannot distinguish an account
   * whose history simply starts high from one with a gap, so it would descend through empty history
   * to block zero paying the deep-request price for windows that can never hold anything.
   */
  readonly firstTxHeight?: number
}

/**
 * Transaction input/output format for storage.
 */
export type StoredTxIO = {
  readonly address: string
  readonly amount: string
  readonly assets: readonly {readonly assetId: string; readonly name: string; readonly amount: string}[]
  readonly id?: string
  readonly index?: number
  readonly txHash?: string
}

/**
 * Stored transaction format.
 */
export type StoredTransaction = {
  readonly hash: string
  readonly blockHash?: string
  readonly blockHeight?: number
  readonly timestamp?: string
  readonly fee?: string
  readonly direction: 'sent' | 'received' | 'self'
  readonly amount: string
  readonly status: 'pending' | 'confirmed' | 'failed'
  readonly metadata?: Record<string, unknown>
  readonly inputs?: readonly StoredTxIO[]
  readonly outputs?: readonly StoredTxIO[]
  readonly withdrawals?: readonly {readonly address: string; readonly amount: string}[]
  readonly certificates?: readonly {
    readonly kind: string
    readonly rewardAddress?: string
    readonly poolKeyHash?: string
    /** DRep target for vote delegation certificates (Conway-era governance) */
    readonly drep?: string
    /** Deposit amount in lovelace for DRep registration/deregistration */
    readonly deposit?: string
  }[]
  readonly collateralInputs?: readonly StoredTxIO[]
  readonly validContract?: boolean
  readonly epoch?: number
  readonly slot?: number
  readonly txOrdinal?: number
}

/**
 * Wallet data store interface.
 */
/** Common parameters for identifying a chain wallet's data. */
export type DataRef = {
  readonly groupId: WalletGroupId
  readonly chainId: ChainId
  readonly accountIndex?: number | undefined
}

export type WalletDataStore = {
  readonly saveSnapshot: (snapshot: WalletSnapshot) => Effect.Effect<void, StoreErrors>
  readonly loadSnapshot: (ref: DataRef) => Effect.Effect<WalletSnapshot | null, StoreErrors>

  // ── Transaction surface (TxTable-backed) ──────────────────────────────────
  // Indexed, projection-friendly storage. List queries return TxListItem
  // (no detail blob); the detail screen reads the full row via
  // `getTxRow`. See `@pnyx/store/tx-table` for the row shape and the
  // classification contract.
  readonly saveTxRow: (row: TxRow) => Effect.Effect<void, StoreErrors>
  readonly saveTxRows: (rows: readonly TxRow[]) => Effect.Effect<void, StoreErrors>
  readonly listTxRows: (query: TxListQuery) => Effect.Effect<readonly TxListItem[], StoreErrors>
  readonly getTxRow: (ref: TxRef, hash: string) => Effect.Effect<TxRow | null, StoreErrors>
  readonly pruneTxRows: (ref: TxRef, keepCount: number) => Effect.Effect<number, StoreErrors>
  readonly clearTxRows: (ref: TxRef) => Effect.Effect<void, StoreErrors>

  // ── UTXO surface (UtxoTable-backed) ───────────────────────────────────────
  // Indexed unspent-output storage. Coin selection, collateral picks, and
  // CIP-30 UTXO queries read here instead of parsing the full snapshot blob.
  // Sync paths call `replaceUtxos` for atomic full-set updates after a chain
  // re-fetch; `deleteUtxos` + `saveUtxos` cover incremental diffs.
  // See `@pnyx/store/utxo-table`.
  readonly saveUtxo: (row: UtxoRow) => Effect.Effect<void, StoreErrors>
  readonly saveUtxos: (rows: readonly UtxoRow[]) => Effect.Effect<void, StoreErrors>
  readonly listUtxos: (query: UtxoListQuery) => Effect.Effect<readonly UtxoRow[], StoreErrors>
  readonly countUtxos: (ref: UtxoRef) => Effect.Effect<number, StoreErrors>
  readonly deleteUtxos: (
    ref: UtxoRef,
    keys: ReadonlyArray<{readonly txHash: string; readonly txIndex: number}>,
  ) => Effect.Effect<void, StoreErrors>
  readonly replaceUtxos: (ref: UtxoRef, rows: readonly UtxoRow[]) => Effect.Effect<void, StoreErrors>
  readonly clearUtxos: (ref: UtxoRef) => Effect.Effect<void, StoreErrors>

  // ── Assets surface (AssetsTable-backed) ──────────────────────────────────
  // Indexed portfolio-asset storage so the Portfolio screen paints cache-first
  // on cold boot instead of waiting on the full getAssets enrichment. Portfolio
  // fetch calls `saveAssets` (atomic full-set replace) per wallet; the screen
  // reads `listAssets`. See `@pnyx/store/assets-table`.
  readonly saveAssets: (ref: AssetRef, rows: readonly AssetRow[]) => Effect.Effect<void, StoreErrors>
  readonly listAssets: (query: AssetListQuery) => Effect.Effect<readonly AssetRow[], StoreErrors>
  readonly countAssets: (ref: AssetRef) => Effect.Effect<number, StoreErrors>
  readonly clearAssets: (ref: AssetRef) => Effect.Effect<void, StoreErrors>

  // ── Address surface (AddressTable-backed) ────────────────────────────────
  // Indexed derived-address storage. CIP-30 `getUsedAddresses` /
  // `getUnusedAddresses`, send-flow mine-set construction, signing-path
  // resolution, and the cross-wallet airdrop scan read here instead of
  // walking `snapshot.addresses.*.derivatives` arrays that grow into the
  // thousands on legacy-wallet multiaddress imports.
  // See `@pnyx/store/address-table`.
  readonly upsertAddress: (row: AddressRow) => Effect.Effect<void, StoreErrors>
  readonly upsertAddresses: (rows: readonly AddressRow[]) => Effect.Effect<void, StoreErrors>
  readonly listAddresses: (query: AddressListQuery) => Effect.Effect<readonly AddressRow[], StoreErrors>
  readonly getAddress: (
    ref: AddressRef,
    branch: AddressBranch,
    index: number,
  ) => Effect.Effect<AddressRow | null, StoreErrors>
  readonly countAddresses: (query: AddressListQuery) => Effect.Effect<number, StoreErrors>
  readonly clearAddresses: (ref: AddressRef) => Effect.Effect<void, StoreErrors>

  readonly clearData: (ref: DataRef) => Effect.Effect<void, StoreErrors>
  readonly hasData: (ref: DataRef) => Effect.Effect<boolean, StoreErrors>
  readonly updateLastSyncAt: (ref: DataRef) => Effect.Effect<void, StoreErrors>
  readonly loadLastSyncAt: (ref: DataRef) => Effect.Effect<number | null, StoreErrors>
  readonly saveTxCheckpoint: (ref: DataRef, checkpoint: TxCheckpoint) => Effect.Effect<void, StoreErrors>
  readonly loadTxCheckpoint: (ref: DataRef) => Effect.Effect<TxCheckpoint | null, StoreErrors>
}

/**
 * WalletDataStore context tag.
 */
export class WalletDataStoreService extends Context.Tag('WalletDataStoreService')<
  WalletDataStoreService,
  WalletDataStore
>() {}

/**
 * Key prefixes for wallet data.
 */
/** Compose a semantic namespace: groupId:chainId:accountIndex */
const dataNs = (groupId: WalletGroupId, chainId: ChainId, accountIndex = 0): string =>
  `${groupId}:${chainId}:${accountIndex}`

const KEYS = {
  snapshot: (groupId: WalletGroupId, chainId: ChainId, accountIndex?: number) =>
    `data:${dataNs(groupId, chainId, accountIndex)}:snapshot`,
  lastSyncAt: (groupId: WalletGroupId, chainId: ChainId, accountIndex?: number) =>
    `data:${dataNs(groupId, chainId, accountIndex)}:lastSyncAt`,
  txCheckpoint: (groupId: WalletGroupId, chainId: ChainId, accountIndex?: number) =>
    `data:${dataNs(groupId, chainId, accountIndex)}:txCheckpoint`,
  dataPrefix: (groupId: WalletGroupId, chainId: ChainId, accountIndex?: number) =>
    `data:${dataNs(groupId, chainId, accountIndex)}:`,
} as const

/**
 * Encode string to Uint8Array.
 */
const encode = (str: string): Uint8Array => new TextEncoder().encode(str)

/**
 * Decode Uint8Array to string.
 */
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

/**
 * Serialize data to JSON bytes.
 */
const serialize = <T>(data: T): Uint8Array => encode(JSON.stringify(data))

/**
 * Deserialize JSON bytes to data.
 */
const deserialize = <T>(bytes: Uint8Array): T => JSON.parse(decode(bytes)) as T

/**
 * Create wallet data store.
 */
/**
 * Build a `WalletDataStore` from its four backing stores.
 *
 * `store` is the KV blob store for snapshots, checkpoints, and the
 * lastSyncAt marker. `txTable` is the indexed transactions store.
 * `utxoTable` is the indexed UTXOs store. `addressTable` is the indexed
 * derived-addresses store. All four are stitched into a single
 * `WalletDataStore` surface so consumers don't need to know which
 * backend serves which method.
 */
export const createWalletDataStore = (
  store: Store,
  txTable: TxTable,
  utxoTable: UtxoTable,
  addressTable: AddressTable,
  assetsTable: AssetsTable,
): WalletDataStore => {
  const saveSnapshot: WalletDataStore['saveSnapshot'] = (snapshot) => {
    const key = encode(KEYS.snapshot(snapshot.groupId, snapshot.chainId, snapshot.accountIndex))
    const value = serialize(snapshot)
    return store.set(key, value)
  }

  const loadSnapshot: WalletDataStore['loadSnapshot'] = ({groupId, chainId, accountIndex}) =>
    Effect.gen(function* () {
      const key = encode(KEYS.snapshot(groupId, chainId, accountIndex))
      const hasKey = yield* store.has(key)
      if (!hasKey) {
        return null
      }
      const value = yield* store.get(key)
      const snapshot = deserialize<WalletSnapshot>(value)
      if ((snapshot as {version?: number}).version !== WALLET_SNAPSHOT_VERSION) {
        return null
      }
      return snapshot
    })

  const clearData: WalletDataStore['clearData'] = ({groupId, chainId, accountIndex}) =>
    Effect.gen(function* () {
      const prefix = encode(KEYS.dataPrefix(groupId, chainId, accountIndex))
      const keysToDelete: Uint8Array[] = []

      yield* store.iterator(prefix).pipe(
        Stream.runForEach(([key, _value]) =>
          Effect.sync(() => {
            keysToDelete.push(key)
          }),
        ),
      )

      if (keysToDelete.length === 0) return
      yield* store.batch(keysToDelete.map((key) => ({type: 'del' as const, key})))
    })

  const hasData: WalletDataStore['hasData'] = ({groupId, chainId, accountIndex}) => {
    const key = encode(KEYS.snapshot(groupId, chainId, accountIndex))
    return store.has(key)
  }

  const updateLastSyncAt: WalletDataStore['updateLastSyncAt'] = ({groupId, chainId, accountIndex}) =>
    store.set(encode(KEYS.lastSyncAt(groupId, chainId, accountIndex)), serialize(Date.now()))

  const loadLastSyncAt: WalletDataStore['loadLastSyncAt'] = ({groupId, chainId, accountIndex}) =>
    Effect.gen(function* () {
      const key = encode(KEYS.lastSyncAt(groupId, chainId, accountIndex))
      const hasKey = yield* store.has(key)
      if (!hasKey) return null
      const value = yield* store.get(key)
      return deserialize<number>(value)
    })

  // ── TxTable delegates ────────────────────────────────────────────────────

  const saveTxRow: WalletDataStore['saveTxRow'] = (row) => txTable.put(row)
  const saveTxRows: WalletDataStore['saveTxRows'] = (rows) => txTable.putMany(rows)
  const listTxRows: WalletDataStore['listTxRows'] = (query) => txTable.list(query)
  const getTxRow: WalletDataStore['getTxRow'] = (ref, hash) => txTable.get(ref, hash)
  const pruneTxRows: WalletDataStore['pruneTxRows'] = (ref, keepCount) => txTable.prune(ref, keepCount)
  const clearTxRows: WalletDataStore['clearTxRows'] = (ref) => txTable.clear(ref)

  // ── UtxoTable delegates ──────────────────────────────────────────────────

  const saveUtxo: WalletDataStore['saveUtxo'] = (row) => utxoTable.put(row)
  const saveUtxos: WalletDataStore['saveUtxos'] = (rows) => utxoTable.putMany(rows)
  const listUtxos: WalletDataStore['listUtxos'] = (query) => utxoTable.list(query)
  const countUtxos: WalletDataStore['countUtxos'] = (ref) => utxoTable.count(ref)
  const deleteUtxos: WalletDataStore['deleteUtxos'] = (ref, keys) => utxoTable.delete(ref, keys)
  const replaceUtxos: WalletDataStore['replaceUtxos'] = (ref, rows) => utxoTable.replaceAll(ref, rows)
  const clearUtxos: WalletDataStore['clearUtxos'] = (ref) => utxoTable.clear(ref)

  // ── AssetsTable delegates ────────────────────────────────────────────────

  const saveAssets: WalletDataStore['saveAssets'] = (ref, rows) => assetsTable.replaceAll(ref, rows)
  const listAssets: WalletDataStore['listAssets'] = (query) => assetsTable.list(query)
  const countAssets: WalletDataStore['countAssets'] = (ref) => assetsTable.count(ref)
  const clearAssets: WalletDataStore['clearAssets'] = (ref) => assetsTable.clear(ref)

  // ── AddressTable delegates ───────────────────────────────────────────────

  const upsertAddress: WalletDataStore['upsertAddress'] = (row) => addressTable.upsert(row)
  const upsertAddresses: WalletDataStore['upsertAddresses'] = (rows) => addressTable.upsertMany(rows)
  const listAddresses: WalletDataStore['listAddresses'] = (query) => addressTable.list(query)
  const getAddress: WalletDataStore['getAddress'] = (ref, branch, index) => addressTable.get(ref, branch, index)
  const countAddresses: WalletDataStore['countAddresses'] = (query) => addressTable.count(query)
  const clearAddresses: WalletDataStore['clearAddresses'] = (ref) => addressTable.clear(ref)

  const saveTxCheckpoint: WalletDataStore['saveTxCheckpoint'] = ({groupId, chainId, accountIndex}, checkpoint) =>
    store.set(encode(KEYS.txCheckpoint(groupId, chainId, accountIndex)), serialize(checkpoint))

  const loadTxCheckpoint: WalletDataStore['loadTxCheckpoint'] = ({groupId, chainId, accountIndex}) =>
    Effect.gen(function* () {
      const key = encode(KEYS.txCheckpoint(groupId, chainId, accountIndex))
      const hasKey = yield* store.has(key)
      if (!hasKey) return null
      const value = yield* store.get(key)
      return deserialize<TxCheckpoint>(value)
    })

  return {
    saveSnapshot,
    loadSnapshot,
    saveTxRow,
    saveTxRows,
    listTxRows,
    getTxRow,
    pruneTxRows,
    clearTxRows,
    saveUtxo,
    saveUtxos,
    listUtxos,
    countUtxos,
    deleteUtxos,
    replaceUtxos,
    clearUtxos,
    saveAssets,
    listAssets,
    countAssets,
    clearAssets,
    upsertAddress,
    upsertAddresses,
    listAddresses,
    getAddress,
    countAddresses,
    clearAddresses,
    clearData,
    hasData,
    updateLastSyncAt,
    loadLastSyncAt,
    saveTxCheckpoint,
    loadTxCheckpoint,
  }
}

/**
 * Create WalletDataStore from StoreService + a constructed TxTable +
 * UtxoTable + AddressTable.
 *
 * Caller-injected tables (rather than `Context.Tag`-resolved) so this
 * Effect stays useful in environments where the table lifecycles are
 * managed alongside the Store (current pattern in wallet-service).
 */
export const createWalletDataStoreEffect = (
  txTable: TxTable,
  utxoTable: UtxoTable,
  addressTable: AddressTable,
  assetsTable: AssetsTable,
): Effect.Effect<WalletDataStore, never, StoreService> =>
  Effect.gen(function* () {
    const store = yield* StoreService
    return createWalletDataStore(store, txTable, utxoTable, addressTable, assetsTable)
  })

export type StoredVotingDelegation = {
  readonly txHash: string
  readonly epoch: number
  readonly slot: number
  readonly drep: DerivativeInfo
  readonly drepType: 'addr_keyhash' | 'scripthash' | 'abstain' | 'no_confidence'
}

export type StoredBalance = {
  readonly id: string
  readonly quantity: string
}
