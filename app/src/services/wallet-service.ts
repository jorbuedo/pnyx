/**
 * Multi-chain wallet service composition.
 *
 * Composes Effect services from @pnyx/wallet and chain-specific packages
 * to provide a unified wallet service for the application.
 * Supports all 29 chains through a provider abstraction.
 *
 * @module
 */

import type {Address as CardanoAddress} from '@pnyx/cardano-core'
import {CARDANO_MAINNET, type ChainId, MIDNIGHT_MAINNET} from '@pnyx/config'
import {hex} from '@pnyx/crypto'
import {PlatformStorageLayerEffect} from '@pnyx/storage'
import type {AddressRow, AddressTable} from '@pnyx/store/address-table'
import {ExpoSQLiteAddressTable} from '@pnyx/store/address-table.expo-sqlite'
import {IndexedDBAddressTable} from '@pnyx/store/address-table.indexeddb'
import {MemoryAddressTable} from '@pnyx/store/address-table.memory'
import type {AssetRow, AssetsTable} from '@pnyx/store/assets-table'
import {ExpoSQLiteAssetsTable} from '@pnyx/store/assets-table.expo-sqlite'
import {IndexedDBAssetsTable} from '@pnyx/store/assets-table.indexeddb'
import {MemoryAssetsTable} from '@pnyx/store/assets-table.memory'
import {ExpoSQLiteStore} from '@pnyx/store/expo-sqlite'
import {IndexedDBStore} from '@pnyx/store/indexeddb'
import type {PricePointTable} from '@pnyx/store/price-point-table'
import {ExpoSQLitePricePointTable} from '@pnyx/store/price-point-table.expo-sqlite'
import {IndexedDBPricePointTable} from '@pnyx/store/price-point-table.indexeddb'
import {MemoryPricePointTable} from '@pnyx/store/price-point-table.memory'
import {MemoryStore, type Store} from '@pnyx/store/store'
import type {TokenMetadataRow, TokenMetadataTable} from '@pnyx/store/token-metadata-table'
import {ExpoSQLiteTokenMetadataTable} from '@pnyx/store/token-metadata-table.expo-sqlite'
import {IndexedDBTokenMetadataTable} from '@pnyx/store/token-metadata-table.indexeddb'
import {MemoryTokenMetadataTable} from '@pnyx/store/token-metadata-table.memory'
import type {TokenPricesTable} from '@pnyx/store/token-prices-table'
import {ExpoSQLiteTokenPricesTable} from '@pnyx/store/token-prices-table.expo-sqlite'
import {IndexedDBTokenPricesTable} from '@pnyx/store/token-prices-table.indexeddb'
import {MemoryTokenPricesTable} from '@pnyx/store/token-prices-table.memory'
import type {TxListItem, TxTable} from '@pnyx/store/tx-table'
import {ExpoSQLiteTxTable} from '@pnyx/store/tx-table.expo-sqlite'
import {IndexedDBTxTable} from '@pnyx/store/tx-table.indexeddb'
import {MemoryTxTable} from '@pnyx/store/tx-table.memory'
import type {UtxoRow, UtxoTable} from '@pnyx/store/utxo-table'
import {ExpoSQLiteUtxoTable} from '@pnyx/store/utxo-table.expo-sqlite'
import {IndexedDBUtxoTable} from '@pnyx/store/utxo-table.indexeddb'
import {MemoryUtxoTable} from '@pnyx/store/utxo-table.memory'
import type {
  ChainWallet,
  Network,
  StoredTransaction,
  TxFetchMode,
  WalletGroup,
  WalletGroupId,
  WalletSelection,
} from '@pnyx/wallet'
import {
  createAddressGeneratorForChain,
  createSyncManager,
  createWalletDataStore,
  createWalletManager,
  type DeriveOnlyAddresses,
  type DeriveOnlyChain,
  getChainFamily,
  getStoredMidnightReceiveAddress,
  midnightNetworkIdForNetwork,
  persistDeriveOnlyAddresses,
  persistDeviceDeriveOnlyAddress,
  persistMidnightReceiveAddresses,
  resolveDeriveOnlyAddresses,
  StorageError,
  SyncError,
  TX_FETCH_MODE,
  toChainWallet,
  WalletCreationError,
  type WalletDataStore,
  type WalletManager as WalletManagerService,
  WalletNotFoundError,
  type WalletSnapshot,
} from '@pnyx/wallet'
import {Context, Effect, Layer, Option, Ref, SubscriptionRef} from 'effect'
import {NETWORKS} from '../config/networks'
import {logger} from '../logger'
import {isNative} from '../platform/detect'
import {paymentCredentialOf} from './cardano/address-credentials'
import {setCardanoDataStore} from './cardano/cardano-store'
import {
  type CardanoDiscoveryOptions,
  type CardanoUsageProbe,
  discoverAndPersistCardanoAddresses,
} from './cardano/discovery'
import {setCardanoAssetsPriceStore} from './cardano-assets/price-store'
import {setCardanoAssetsTokenStore} from './cardano-assets/token-store'
import {loadCachedChainSnapshot} from './chain-sync/index'
import {chainKeepsSnapshots} from './chain-sync/snapshot-expectation'
import {nonDerivedAddresses} from './non-derived-addresses'
import {setPricePointStore} from './price-history/price-point-store'
import {activeDbInfix} from './profile/active-profile'
import {coveringSyncKey, syncDedupKey} from './sync-dedup'
import {TRANSIENT_STORAGE_SYNC_RETRY} from './transient-storage-retry'

/**
 * Create the appropriate store based on platform.
 *
 * Uses expo-sqlite on React Native (unlimited storage).
 */
const createPlatformStore = (network: Network): Effect.Effect<Store, never> =>
  Effect.gen(function* () {
    const dbName = `pnyx-${activeDbInfix()}${network}.db`
    const idbName = `pnyx-wallet-${activeDbInfix()}${network}`

    // React Native: use expo-sqlite (unlimited storage, proper SQL)
    if (isNative) {
      logger.debug('Using SQLite store for React Native', {origin: 'WalletService', dbName})
      const storeResult = yield* ExpoSQLiteStore(dbName).pipe(
        Effect.catchAll((e) => {
          logger.warn('SQLite not available, using memory store', {origin: 'WalletService', error: String(e)})
          return MemoryStore
        }),
      )
      return storeResult
    }

    // Browser: use IndexedDB
    if (typeof indexedDB !== 'undefined') {
      logger.debug('Using IndexedDB store for browser', {origin: 'WalletService', idbName})
      const storeResult = yield* IndexedDBStore(idbName).pipe(
        Effect.catchAll((e) => {
          logger.warn('IndexedDB not available, using memory store', {origin: 'WalletService', error: String(e)})
          return MemoryStore
        }),
      )
      return storeResult
    }

    // Fall back to memory store for non-browser environments
    logger.warn('No persistent store available, using memory store', {origin: 'WalletService'})
    return yield* MemoryStore
  })

/**
 * Create the appropriate transactions table based on platform.
 *
 * Mirrors {@link createPlatformStore} but for the indexed transactions
 * store (TxTable). The two backends share the same network prefix so
 * dev-tools can wipe them together, but live in separate database files
 * — schema bumps on TxTable don't disturb wallet snapshots in the KV
 * store.
 */
const createPlatformTxTable = (network: Network): Effect.Effect<TxTable, never> =>
  Effect.gen(function* () {
    const dbName = `pnyx-tx-${activeDbInfix()}${network}.db`
    const idbName = `pnyx-tx-${activeDbInfix()}${network}`

    if (isNative) {
      logger.debug('Using SQLite tx-table for React Native', {origin: 'WalletService', dbName})
      return yield* ExpoSQLiteTxTable(dbName).pipe(
        Effect.catchAll((e) => {
          logger.warn('SQLite tx-table not available, using memory tx-table', {
            origin: 'WalletService',
            error: String(e),
          })
          return MemoryTxTable
        }),
      )
    }

    if (typeof indexedDB !== 'undefined') {
      logger.debug('Using IndexedDB tx-table for browser', {origin: 'WalletService', idbName})
      return yield* IndexedDBTxTable(idbName).pipe(
        Effect.catchAll((e) => {
          logger.warn('IndexedDB tx-table not available, using memory tx-table', {
            origin: 'WalletService',
            error: String(e),
          })
          return MemoryTxTable
        }),
      )
    }

    logger.warn('No persistent tx-table available, using memory tx-table', {origin: 'WalletService'})
    return yield* MemoryTxTable
  })

/**
 * Create the appropriate UTXOs table based on platform.
 *
 * Mirrors {@link createPlatformTxTable}: dedicated database per network,
 * separate file/IDB so UTXO schema bumps don't disturb tx or snapshot
 * storage.
 */
const createPlatformUtxoTable = (network: Network): Effect.Effect<UtxoTable, never> =>
  Effect.gen(function* () {
    const dbName = `pnyx-utxo-${activeDbInfix()}${network}.db`
    const idbName = `pnyx-utxo-${activeDbInfix()}${network}`

    if (isNative) {
      logger.debug('Using SQLite utxo-table for React Native', {origin: 'WalletService', dbName})
      return yield* ExpoSQLiteUtxoTable(dbName).pipe(
        Effect.catchAll((e) => {
          logger.warn('SQLite utxo-table not available, using memory utxo-table', {
            origin: 'WalletService',
            error: String(e),
          })
          return MemoryUtxoTable
        }),
      )
    }

    if (typeof indexedDB !== 'undefined') {
      logger.debug('Using IndexedDB utxo-table for browser', {origin: 'WalletService', idbName})
      return yield* IndexedDBUtxoTable(idbName).pipe(
        Effect.catchAll((e) => {
          logger.warn('IndexedDB utxo-table not available, using memory utxo-table', {
            origin: 'WalletService',
            error: String(e),
          })
          return MemoryUtxoTable
        }),
      )
    }

    logger.warn('No persistent utxo-table available, using memory utxo-table', {origin: 'WalletService'})
    return yield* MemoryUtxoTable
  })

/**
 * Create the appropriate assets table based on platform. Dedicated database per
 * network so portfolio-asset schema bumps don't disturb tx/utxo/snapshot
 * storage. Backs the Portfolio screen's cache-first cold-boot paint.
 */
const createPlatformAssetsTable = (network: Network): Effect.Effect<AssetsTable, never> =>
  Effect.gen(function* () {
    const dbName = `pnyx-assets-${activeDbInfix()}${network}.db`
    const idbName = `pnyx-assets-${activeDbInfix()}${network}`

    if (isNative) {
      return yield* ExpoSQLiteAssetsTable(dbName).pipe(
        Effect.catchAll((e) => {
          logger.warn('SQLite assets-table not available, using memory assets-table', {
            origin: 'WalletService',
            error: String(e),
          })
          return MemoryAssetsTable
        }),
      )
    }

    if (typeof indexedDB !== 'undefined') {
      return yield* IndexedDBAssetsTable(idbName).pipe(
        Effect.catchAll(() => {
          logger.warn('IndexedDB assets-table not available, using memory assets-table', {origin: 'WalletService'})
          return MemoryAssetsTable
        }),
      )
    }

    logger.warn('No persistent assets-table available, using memory assets-table', {origin: 'WalletService'})
    return yield* MemoryAssetsTable
  })

/**
 * Create the appropriate token-metadata table based on platform. One shared
 * (per-network) cache of token metadata keyed by tokenId — fetched once, reused
 * across every wallet. Cuts the bulk of the portfolio enrichment's per-refresh
 * token-metadata requests.
 */
const createPlatformTokenMetadataTable = (network: Network): Effect.Effect<TokenMetadataTable, never> =>
  Effect.gen(function* () {
    const dbName = `pnyx-token-metadata-${activeDbInfix()}${network}.db`
    const idbName = `pnyx-token-metadata-${activeDbInfix()}${network}`

    if (isNative) {
      return yield* ExpoSQLiteTokenMetadataTable(dbName).pipe(
        Effect.catchAll((e) => {
          logger.warn('SQLite token-metadata not available, using memory', {origin: 'WalletService', error: String(e)})
          return MemoryTokenMetadataTable
        }),
      )
    }

    if (typeof indexedDB !== 'undefined') {
      return yield* IndexedDBTokenMetadataTable(idbName).pipe(
        Effect.catchAll(() => {
          logger.warn('IndexedDB token-metadata not available, using memory', {origin: 'WalletService'})
          return MemoryTokenMetadataTable
        }),
      )
    }

    return yield* MemoryTokenMetadataTable
  })

/**
 * Create the appropriate token-prices table based on platform. Durable backing
 * for the RAM price cache (`cardano-assets/price-cache`); falls back to memory
 * when the platform store is unavailable.
 */
const createPlatformTokenPricesTable = (network: Network): Effect.Effect<TokenPricesTable, never> =>
  Effect.gen(function* () {
    const dbName = `pnyx-token-prices-${activeDbInfix()}${network}.db`
    const idbName = `pnyx-token-prices-${activeDbInfix()}${network}`

    if (isNative) {
      return yield* ExpoSQLiteTokenPricesTable(dbName).pipe(
        Effect.catchAll((e) => {
          logger.warn('SQLite token-prices not available, using memory', {origin: 'WalletService', error: String(e)})
          return MemoryTokenPricesTable
        }),
      )
    }

    if (typeof indexedDB !== 'undefined') {
      return yield* IndexedDBTokenPricesTable(idbName).pipe(
        Effect.catchAll(() => {
          logger.warn('IndexedDB token-prices not available, using memory', {origin: 'WalletService'})
          return MemoryTokenPricesTable
        }),
      )
    }

    return yield* MemoryTokenPricesTable
  })

/**
 * Create the appropriate price-point table based on platform. Durable backing
 * for the price-history series (`price-history/price-point-store`); falls back
 * to memory when the platform store is unavailable. Historical points are
 * immutable, so this is a pure cache — a cold read never blocks on the network.
 */
const createPlatformPricePointTable = (network: Network): Effect.Effect<PricePointTable, never> =>
  Effect.gen(function* () {
    const dbName = `pnyx-price-point-${activeDbInfix()}${network}.db`
    const idbName = `pnyx-price-point-${activeDbInfix()}${network}`

    if (isNative) {
      return yield* ExpoSQLitePricePointTable(dbName).pipe(
        Effect.catchAll((e) => {
          logger.warn('SQLite price-point not available, using memory', {origin: 'WalletService', error: String(e)})
          return MemoryPricePointTable
        }),
      )
    }

    if (typeof indexedDB !== 'undefined') {
      return yield* IndexedDBPricePointTable(idbName).pipe(
        Effect.catchAll(() => {
          logger.warn('IndexedDB price-point not available, using memory', {origin: 'WalletService'})
          return MemoryPricePointTable
        }),
      )
    }

    return yield* MemoryPricePointTable
  })

/**
 * Create the appropriate addresses table based on platform.
 *
 * Mirrors {@link createPlatformTxTable} / {@link createPlatformUtxoTable}:
 * dedicated database per network, separate file/IDB so address schema
 * bumps don't disturb tx, utxo, or snapshot storage.
 */
/**
 * The address table Midnight receive addresses live in — **not** scoped by network.
 *
 * Those rows are derivation output, not chain observation: they come from the seed
 * at wallet creation and nothing re-derives them on read. Kept in the per-network
 * table they were written once into whichever network happened to be active and
 * lost for good on the next switch, since {@link createWalletService}'s network
 * change reopens that table. The Midnight network lives in the row key instead
 * (`midnightAddressStoreKey`), so every network's set is written together and any
 * later switch finds its own.
 *
 * Still profile-scoped: a decoy profile must not read the real one's addresses.
 */
/**
 * The Midnight networks a wallet's receive addresses are derived for at creation.
 *
 * Every network the picker offers, because the seed is only in hand once and a
 * switch cannot derive. `midnightNetworkIdForNetwork` is identity, so the app's
 * network names are the Midnight ones.
 */
const MIDNIGHT_RECEIVE_NETWORKS = NETWORKS.map(midnightNetworkIdForNetwork)

/**
 * The `hash` column for an address we did not derive.
 *
 * ⚠️ **Both non-derived writers used to store the bech32 address here**, in a column
 * every other row fills with a 28-byte payment key hash. Nothing read it, so the
 * inconsistency was latent — but it makes the column mean two different things
 * depending on which writer produced the row, and a script address has no payment
 * *key* hash to store in the first place.
 *
 * The payment credential is readable from the address itself with no keys and no
 * derivation, so it is the honest value for a script or watched address alike.
 * Falling back to the address is the old behaviour, kept for a case that should not
 * happen — we built or validated this address moments ago — and warned about rather
 * than passed over.
 */
const addressRowHash = (bech32Address: string, what: string): string => {
  const credential = paymentCredentialOf(bech32Address)
  if (credential !== null) return credential
  logger.warn('Could not read a payment credential from an address; storing the address itself', {
    origin: 'WalletService',
    what,
  })
  return bech32Address
}

const createMidnightAddressTable = (): Effect.Effect<AddressTable, never> =>
  Effect.gen(function* () {
    const dbName = `pnyx-address-${activeDbInfix()}midnight.db`
    const idbName = `pnyx-address-${activeDbInfix()}midnight`

    if (isNative) {
      logger.debug('Using SQLite address-table for Midnight receive addresses', {origin: 'WalletService', dbName})
      return yield* ExpoSQLiteAddressTable(dbName).pipe(
        Effect.catchAll((e) => {
          logger.warn('SQLite Midnight address-table not available, using memory', {
            origin: 'WalletService',
            error: String(e),
          })
          return MemoryAddressTable
        }),
      )
    }

    if (typeof indexedDB !== 'undefined') {
      logger.debug('Using IndexedDB address-table for Midnight receive addresses', {
        origin: 'WalletService',
        idbName,
      })
      return yield* IndexedDBAddressTable(idbName).pipe(
        Effect.catchAll((e) => {
          logger.warn('IndexedDB Midnight address-table not available, using memory', {
            origin: 'WalletService',
            error: String(e),
          })
          return MemoryAddressTable
        }),
      )
    }

    return yield* MemoryAddressTable
  })

const createPlatformAddressTable = (network: Network): Effect.Effect<AddressTable, never> =>
  Effect.gen(function* () {
    const dbName = `pnyx-address-${activeDbInfix()}${network}.db`
    const idbName = `pnyx-address-${activeDbInfix()}${network}`

    if (isNative) {
      logger.debug('Using SQLite address-table for React Native', {origin: 'WalletService', dbName})
      return yield* ExpoSQLiteAddressTable(dbName).pipe(
        Effect.catchAll((e) => {
          logger.warn('SQLite address-table not available, using memory address-table', {
            origin: 'WalletService',
            error: String(e),
          })
          return MemoryAddressTable
        }),
      )
    }

    if (typeof indexedDB !== 'undefined') {
      logger.debug('Using IndexedDB address-table for browser', {origin: 'WalletService', idbName})
      return yield* IndexedDBAddressTable(idbName).pipe(
        Effect.catchAll((e) => {
          logger.warn('IndexedDB address-table not available, using memory address-table', {
            origin: 'WalletService',
            error: String(e),
          })
          return MemoryAddressTable
        }),
      )
    }

    logger.warn('No persistent address-table available, using memory address-table', {origin: 'WalletService'})
    return yield* MemoryAddressTable
  })

/** Non-throwing {@link getChainFamily}: `null` for chains outside the supported set. */
const chainFamilyOf = (chainId: ChainId): 'midnight' | 'cardano' | null => {
  try {
    return getChainFamily(chainId)
  } catch (e: unknown) {
    // `null` is the documented "outside the supported set" answer, so this is debug — but a
    // chain we support that failed to classify would otherwise be invisible.
    logger.debug('Chain family could not be resolved', {origin: 'wallet-service', chainId, error: String(e)})
    return null
  }
}

/** Extract a meaningful message from various error types */
const getErrorMessage = (e: unknown): string => {
  if (e && typeof e === 'object') {
    if ('message' in e && typeof e.message === 'string' && e.message) {
      return e.message
    }
    if ('_tag' in e && typeof e._tag === 'string') {
      // Handle TaggedErrors without message property
      if ('groupId' in e) return `Wallet not found: ${e.groupId}`
      if ('accountId' in e) return `Account not found: ${e.accountId}`
      if ('required' in e && 'available' in e)
        return `Insufficient funds: required ${e.required}, available ${e.available}`
      return e._tag
    }
  }
  return String(e)
}

/**
 * Wallet service configuration.
 */
export type WalletServiceConfig = {
  /** Network to connect to */
  readonly network: Network
  /** Custom explorer URL (optional) */
  readonly explorerUrl?: string
  /** Enabled chains for this wallet service */
  readonly enabledChains?: readonly ChainId[]
  /** Custom store factory (defaults to platform-aware SQLite/IndexedDB/Memory) */
  readonly storeFactory?: (network: Network) => Effect.Effect<Store, never>
  /** Custom tx-table factory (defaults to platform-aware SQLite/IndexedDB/Memory) */
  readonly txTableFactory?: (network: Network) => Effect.Effect<TxTable, never>
  /** Custom utxo-table factory (defaults to platform-aware SQLite/IndexedDB/Memory) */
  readonly utxoTableFactory?: (network: Network) => Effect.Effect<UtxoTable, never>
  /** Custom address-table factory (defaults to platform-aware SQLite/IndexedDB/Memory) */
  readonly addressTableFactory?: (network: Network) => Effect.Effect<AddressTable, never>
  /** The network-independent table holding Midnight receive addresses. */
  readonly midnightAddressTableFactory?: () => Effect.Effect<AddressTable, never>
  /** Custom assets-table factory (defaults to platform-aware SQLite/IndexedDB/Memory) */
  readonly assetsTableFactory?: (network: Network) => Effect.Effect<AssetsTable, never>
  /** Custom token-metadata-table factory (defaults to platform-aware SQLite/IndexedDB/Memory) */
  readonly tokenMetadataTableFactory?: (network: Network) => Effect.Effect<TokenMetadataTable, never>
  /** Custom token-prices-table factory (defaults to platform-aware SQLite/IndexedDB/Memory) */
  readonly tokenPricesTableFactory?: (network: Network) => Effect.Effect<TokenPricesTable, never>
  /** Custom price-point-table factory (defaults to platform-aware SQLite/IndexedDB/Memory) */
  readonly pricePointTableFactory?: (network: Network) => Effect.Effect<PricePointTable, never>
  /** Custom storage layer for WalletManager persistence (defaults to PlatformStorageLayerEffect) */
  readonly storageLayer?: typeof PlatformStorageLayerEffect
}

/**
 * Multi-chain wallet service state that can be observed by React.
 *
 * Wallet data (balances, addresses, staking, utxos) lives in snapshots.
 * Consumers derive what they need from `snapshots.get(snapshotKey(...))`.
 */
/** Key for snapshot map: groupId:chainId:accountIndex */
export type SnapshotKey = string
export const snapshotKey = (groupId: WalletGroupId, chainId: ChainId, accountIndex = 0): SnapshotKey =>
  `${groupId}:${chainId}:${accountIndex}`

export type WalletServiceState = {
  readonly network: Network
  readonly groups: ReadonlyMap<WalletGroupId, WalletGroup>
  readonly selection: WalletSelection | null
  /** Wallet snapshots keyed by groupId:chainId:accountIndex */
  readonly snapshots: ReadonlyMap<SnapshotKey, WalletSnapshot>
  readonly isSyncing: boolean
  readonly lastError: string | null
}

/**
 * Wallet service provides unified access to all wallet functionality.
 */
export type WalletService = {
  /** Current state, observable from React through `useServiceState` */
  readonly state: SubscriptionRef.SubscriptionRef<WalletServiceState>

  /** Wallet manager for CRUD operations */
  readonly walletManager: WalletManagerService

  /** Get the current state */
  readonly getState: () => Effect.Effect<WalletServiceState, never>

  /** Create a new wallet from mnemonic (seed persistence is the caller's job — enclave vault). */
  readonly createWallet: (params: {
    name: string
    mnemonic: string
    chainId?: ChainId
    groupId?: string
    source?: import('@pnyx/wallet').WalletSource
  }) => Effect.Effect<WalletGroup, import('@pnyx/wallet').WalletCreationError>

  /** Restore a wallet from mnemonic */
  readonly restoreWallet: (params: {
    name: string
    mnemonic: string
    chainId?: ChainId
    groupId?: string
  }) => Effect.Effect<WalletGroup, import('@pnyx/wallet').WalletCreationError>

  /** Select a wallet group + chain + account */
  readonly select: (selection: WalletSelection) => Effect.Effect<void, import('@pnyx/wallet').WalletNotFoundError>

  /** Deselect (return to aggregate view) */
  readonly deselect: () => Effect.Effect<void, never>

  /** Load cached snapshot for any chain wallet */
  readonly loadSnapshot: (
    groupId: WalletGroupId,
    chainId: ChainId,
    accountIndex?: number,
  ) => Effect.Effect<WalletSnapshot | null, never>

  /** Load a single transaction by hash (O(1) direct key lookup) */
  readonly loadTransaction: (
    groupId: WalletGroupId,
    chainId: ChainId,
    txHash: string,
    accountIndex?: number,
  ) => Effect.Effect<StoredTransaction | null, never>

  /**
   * List transaction rows for the activity view — projection only.
   *
   * Returns indexed, sorted, projected rows without the `detailJson` blob.
   * Pair with {@link loadTransaction} when the detail screen opens and a
   * full {@link StoredTransaction} is needed.
   */
  readonly listTransactionRows: (
    groupId: WalletGroupId,
    chainId: ChainId,
    accountIndex?: number,
    query?: {readonly limit?: number; readonly offset?: number; readonly olderThan?: number},
  ) => Effect.Effect<readonly TxListItem[], Error>
  /**
   * Global (current-network) token-metadata cache, keyed by tokenId. `getTokenMetadata`
   * returns cached entries (caller diffs for misses + applies a staleness TTL on
   * `fetchedAt`); `saveTokenMetadata` upserts freshly-fetched metadata.
   */
  readonly getTokenMetadata: (
    tokenIds: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, {data: unknown; fetchedAt: number}>, never>
  readonly saveTokenMetadata: (
    entries: readonly {tokenId: string; data: unknown}[],
    now: number,
  ) => Effect.Effect<void, never>

  /**
   * Row-form variants of the asset / token-metadata cache, used by the
   * extension background so the popup ↔ background bridge passes the
   * string-safe row (never the raw `ChainPortfolioAsset`, whose bigint
   * `assetBalance` can't be structured-cloned across `chrome.runtime`).
   * `listAssetRows` accepts a `limit` (top holdings by usdValue) to keep the
   * message small; `saveTokenMetadataRows` stamps the current network.
   */
  readonly listAssetRows: (
    groupId: WalletGroupId,
    chainId: ChainId,
    accountIndex?: number,
    limit?: number,
  ) => Effect.Effect<readonly AssetRow[], never>
  readonly saveAssetRows: (
    groupId: WalletGroupId,
    chainId: ChainId,
    accountIndex: number,
    rows: readonly AssetRow[],
  ) => Effect.Effect<void, never>
  readonly getTokenMetadataRows: (tokenIds: readonly string[]) => Effect.Effect<readonly TokenMetadataRow[], never>
  readonly saveTokenMetadataRows: (
    entries: readonly {tokenId: string; detailJson: string; fetchedAt: number}[],
  ) => Effect.Effect<void, never>

  /**
   * List UTXO rows for a chain wallet — indexed read from the UtxoTable.
   *
   * Replaces the legacy `snapshot.utxos` access — coin selection,
   * collateral picks, and dApp connector requests go through this.
   * Optional `pureOnly` filters to UTXOs with no native-token bundle
   * (Plutus collateral candidates).
   */
  readonly listUtxos: (
    groupId: WalletGroupId,
    chainId: ChainId,
    accountIndex?: number,
    options?: {readonly pureOnly?: boolean},
  ) => Effect.Effect<readonly UtxoRow[], never>

  /**
   * List address rows for a chain wallet — indexed read from the AddressTable.
   *
   * Replaces direct `snapshot.addresses.*.derivatives` access. Filter by
   * `branch` to scope to receive (`external`), change (`internal`), or
   * single-address chains (`single`). `isUsed` filters to addresses
   * observed on-chain.
   */
  readonly listAddresses: (
    groupId: WalletGroupId,
    chainId: ChainId,
    accountIndex?: number,
    options?: {readonly branch?: 'external' | 'internal' | 'single'; readonly isUsed?: boolean},
  ) => Effect.Effect<readonly AddressRow[], never>

  /**
   * List address rows for a chain across every wallet group — the
   * AddressTable's `(chainId, isUsed)` index makes this a single SQL
   * read regardless of group count. Used by send-flow heuristics that
   * need to know "is this address one of MY addresses anywhere" and
   * "which group owns this address", e.g. self-send detection and
   * save-contact name prefill.
   */
  readonly listAddressesForChain: (chainId: ChainId) => Effect.Effect<readonly AddressRow[], never>

  /** Rename a wallet group */
  readonly renameGroup: (
    groupId: WalletGroupId,
    name: string,
  ) => Effect.Effect<void, import('@pnyx/wallet').WalletNotFoundError>

  /** Delete a wallet group */
  readonly deleteGroup: (groupId: WalletGroupId) => Effect.Effect<void, import('@pnyx/wallet').WalletNotFoundError>

  /** Sync the selected wallet */
  readonly sync: () => Effect.Effect<void, SyncError>

  /** Sync a specific chain wallet. */
  readonly syncChainWallet: (
    groupId: WalletGroupId,
    chainId: ChainId,
    options?: {txMode?: TxFetchMode},
  ) => Effect.Effect<void, SyncError>

  /** Sync a specific chain for the selected wallet */
  readonly syncChain: (chainId: ChainId) => Effect.Effect<void, SyncError>

  /** Get the snapshot for the selected wallet */
  readonly getSelectedSnapshot: () => Effect.Effect<WalletSnapshot | null, never>

  /** Save wallet state to storage */
  readonly save: () => Effect.Effect<void, import('@pnyx/wallet').StorageError>

  /** Load wallet state from storage */
  readonly load: () => Effect.Effect<void, import('@pnyx/wallet').StorageError>

  /** Get receive address. All params optional — defaults to selected group, selected chain, account 0, address 0. */
  readonly getReceiveAddress: (params?: {
    readonly groupId?: WalletGroupId
    readonly chainId?: ChainId
    readonly accountIndex?: number
    readonly addressIndex?: number
  }) => Effect.Effect<string, SyncError>

  /**
   * Write any Midnight receive addresses this group is missing, for every network.
   *
   * The repair path for wallets created before those rows were network-keyed: they
   * have a set for whichever network was active at creation and none for the rest,
   * and a switch cannot derive because nothing re-derives on read. Call it wherever
   * a mnemonic is already in hand — it costs no extra vault read, and it is
   * idempotent, so calling it on every sync is free once the set is complete.
   *
   * Returns the networks it actually wrote.
   */
  readonly ensureMidnightReceiveAddresses: (params: {
    readonly groupId: WalletGroupId
    readonly mnemonic: string
    readonly accountIndex?: number
  }) => Effect.Effect<readonly string[], SyncError>

  /** Read stored derive-only companion addresses (BTC/EVM/SOL) for a group. */
  readonly getDeriveOnlyAddresses: (
    groupId: WalletGroupId,
    accountIndex?: number,
  ) => Effect.Effect<Partial<DeriveOnlyAddresses>, SyncError>

  /**
   * Seedless Cardano address discovery: derive the CIP-1852 book from the
   * stored account xpub, gap-limit scan external+internal via `probe`, persist
   * the rows, and return the addresses the rail should sync (used + primary).
   * No seed / no prompt — falls back to a scheduled xpub backfill when the xpub
   * is not yet persisted (returns `[]`, letting the caller keep primary-only).
   */
  readonly discoverCardanoAddresses: (
    groupId: WalletGroupId,
    network: CardanoAddress.Network,
    probe: CardanoUsageProbe,
    accountIndex?: number,
    options?: CardanoDiscoveryOptions,
  ) => Effect.Effect<readonly string[], SyncError>

  /**
   * Create a read-only ("watch-only") Cardano wallet from a resolved
   * key-credential base-address set (see `cardano/read-only.ts`; `addresses[0]`
   * is the primary). Persists the primary as Cardano `external[0]` so
   * `getDeriveOnlyAddresses` bootstraps the rail; the live balance comes from the
   * account-level UTxO endpoint and history derives its own address set at
   * runtime (see `useCardanoRail`). No seed, no xpub.
   */
  readonly createReadOnlyCardanoWallet: (params: {
    readonly name: string
    readonly addresses: readonly string[]
    readonly checksumSeed?: string
  }) => Effect.Effect<WalletGroup, SyncError>

  /**
   * Register a CIP-1854 shared wallet as a wallet group, so it appears in the
   * wallet list and every ordinary flow can select it.
   *
   * Seedless like a watch-only group — it holds no key of its own — but not
   * read-only: it receives, and spends once its quorum signs. `groupId` is the
   * shared wallet's own id, which makes re-registration idempotent.
   */
  readonly createSharedWalletGroup: (params: {
    readonly groupId: string
    readonly name: string
    readonly addresses: readonly string[]
    readonly checksumSeed?: string
  }) => Effect.Effect<WalletGroup, SyncError>

  /**
   * Persist a derive-only receive address obtained directly from a hardware
   * device (Solana — no seed to derive it, no public-child derivation). BTC/EVM
   * come from their stored xpub instead and need no row.
   */
  readonly persistDeviceDeriveOnlyAddress: (params: {
    readonly groupId: string
    readonly chain: DeriveOnlyChain
    readonly accountIndex: number
    readonly address: string
  }) => Effect.Effect<void, SyncError>

  /** Load cached snapshots for all chains in a group */
  readonly loadGroupSnapshots: (groupId: WalletGroupId) => Effect.Effect<void, never>

  /** Get stake address for the selected wallet */
  readonly getStakeAddress: () => Effect.Effect<string, SyncError>

  /** Get change address. All params optional — defaults to selected group, selected chain, account 0. */
  readonly getChangeAddress: (params?: {
    readonly groupId?: WalletGroupId
    readonly chainId?: ChainId
    readonly accountIndex?: number
  }) => Effect.Effect<string, SyncError>

  /** Get all used addresses for the selected wallet (CIP-30 compliance) */
  readonly getUsedAddresses: () => Effect.Effect<readonly string[], never>

  /** Get unused addresses for the selected wallet (CIP-30 getUnusedAddresses) */
  readonly getUnusedAddresses: () => Effect.Effect<readonly string[], never>

  /** Get used addresses with derivation indices (for signData path resolution) */
  readonly getUsedAddressesIndexed: () => Effect.Effect<
    readonly {readonly address: string; readonly index: number}[],
    never
  >

  /** Get unused addresses with derivation indices */
  readonly getUnusedAddressesIndexed: () => Effect.Effect<
    readonly {readonly address: string; readonly index: number}[],
    never
  >

  /** Get internal/change addresses with derivation indices */
  readonly getInternalAddressesIndexed: () => Effect.Effect<
    readonly {readonly address: string; readonly index: number}[],
    never
  >

  /** Import a wallet from extended public key. Source determines wallet type (hardware, read-only, etc.). */
  /** Cache a pre-derived account-level xpub without enabling the chain. */
  readonly cacheAccountXPub: (params: {
    groupId: import('@pnyx/wallet').WalletGroupId
    chainId: ChainId
    publicKey: Uint8Array
    chainCode: Uint8Array
    accountIndex?: number
  }) => Effect.Effect<void, import('@pnyx/wallet').WalletCreationError>

  /** Update the source of a wallet group (e.g., upgrade from 'imported-xpriv' to 'mnemonic'). */
  readonly updateSource: (
    groupId: import('@pnyx/wallet').WalletGroupId,
    source: import('@pnyx/wallet').WalletSource,
  ) => Effect.Effect<import('@pnyx/wallet').WalletGroup, import('@pnyx/wallet').WalletNotFoundError>

  /**
   * Enable a new chain for an existing wallet group.
   *
   * For the slow path (no cached xpub), pass a pre-decrypted mnemonic
   * in `opts.mnemonic` — the WalletProvider does this so the enclave
   * vault is the one source of truth for "where the seed lives".
   */
  readonly enableChain: (
    groupId: import('@pnyx/wallet').WalletGroupId,
    chainId: ChainId,
    opts?: {readonly mnemonic?: string},
  ) => Effect.Effect<ChainWallet, import('@pnyx/wallet').WalletCreationError | StorageError>

  /** Disable a chain for an existing wallet group */
  readonly disableChain: (
    groupId: import('@pnyx/wallet').WalletGroupId,
    chainId: ChainId,
  ) => Effect.Effect<void, import('@pnyx/wallet').WalletNotFoundError>

  /** Switch to a different network (closes old store, opens new one) */
  readonly switchNetwork: (network: Network) => Effect.Effect<void, never>

  /** Get the network ID (1 for mainnet, 0 for testnets) */
  readonly getNetworkId: () => Effect.Effect<number, never>

  /** Close the underlying store to release database connections */
  readonly close: () => Effect.Effect<void, never>
}

/**
 * WalletService context tag for dependency injection.
 */
export const WalletService = Context.GenericTag<WalletService>('WalletService')

/**
 * Create initial wallet service state.
 */
const createInitialState = (network: Network): WalletServiceState => ({
  network,
  groups: new Map(),
  selection: null,
  snapshots: new Map(),
  isSyncing: false,
  lastError: null,
})

/**
 * Create the wallet service.
 */
export const createWalletService = (config: WalletServiceConfig): Effect.Effect<WalletService, never, never> =>
  Effect.gen(function* () {
    logger.debug('Creating wallet service', {origin: 'WalletService', network: config.network})

    // Resolve injectable dependencies with defaults
    const storeFactory = config.storeFactory ?? createPlatformStore
    const txTableFactory = config.txTableFactory ?? createPlatformTxTable
    const utxoTableFactory = config.utxoTableFactory ?? createPlatformUtxoTable
    const addressTableFactory = config.addressTableFactory ?? createPlatformAddressTable
    const assetsTableFactory = config.assetsTableFactory ?? createPlatformAssetsTable
    const tokenMetadataTableFactory = config.tokenMetadataTableFactory ?? createPlatformTokenMetadataTable
    const tokenPricesTableFactory = config.tokenPricesTableFactory ?? createPlatformTokenPricesTable
    const pricePointTableFactory = config.pricePointTableFactory ?? createPlatformPricePointTable
    const storageLayerForPersistence = config.storageLayer ?? PlatformStorageLayerEffect

    // Create state ref for React integration
    const state = yield* SubscriptionRef.make<WalletServiceState>(createInitialState(config.network))

    // Track concurrent syncs so isSyncing stays true until ALL syncs finish
    let activeSyncCount = 0
    let pendingSyncErrors: string[] = []

    const beginSync = (): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        activeSyncCount++
        if (activeSyncCount === 1) {
          pendingSyncErrors = []
          yield* SubscriptionRef.update(state, (s) => ({...s, isSyncing: true, lastError: null}))
        }
      })

    const endSync = (error?: string): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        if (error) {
          pendingSyncErrors.push(error)
        }
        activeSyncCount = Math.max(0, activeSyncCount - 1)
        if (activeSyncCount === 0) {
          const lastError = pendingSyncErrors.length > 0 ? pendingSyncErrors.join('; ') : null
          pendingSyncErrors = []
          yield* SubscriptionRef.update(state, (s) => ({...s, isSyncing: false, ...(lastError ? {lastError} : {})}))
        }
      })

    const updateState = (updater: (prev: WalletServiceState) => WalletServiceState): Effect.Effect<void, never> =>
      SubscriptionRef.update(state, updater)

    // Mutable resources that are replaced on network switch
    let currentNetwork = config.network
    let store = yield* storeFactory(config.network)
    let txTable = yield* txTableFactory(config.network)
    let utxoTable = yield* utxoTableFactory(config.network)
    let addressTable = yield* addressTableFactory(config.network)
    // Created once and never reopened on a network change — that is the whole point
    // of it: see createMidnightAddressTable.
    const midnightAddressTable = yield* (config.midnightAddressTableFactory ?? createMidnightAddressTable)()
    let assetsTable = yield* assetsTableFactory(config.network)
    let tokenMetadataTable = yield* tokenMetadataTableFactory(config.network)
    let tokenPricesTable = yield* tokenPricesTableFactory(config.network)
    let pricePointTable = yield* pricePointTableFactory(config.network)
    let walletStore: WalletDataStore = createWalletDataStore(store, txTable, utxoTable, addressTable, assetsTable)
    setCardanoDataStore(walletStore)
    setCardanoAssetsTokenStore(tokenMetadataTable)
    setCardanoAssetsPriceStore(tokenPricesTable)
    setPricePointStore(pricePointTable)
    logger.debug('Wallet data store initialized', {origin: 'WalletService', network: config.network})

    // The chains this service serves. There is no provider registry any more: the generic
    // `ChainProvider` port it handed out was never implemented, and both real rails fetch through their
    // own services (`docs/MIDNIGHT_WALLET_ARCHITECTURE.md` §1).
    const enabledChains = config.enabledChains ?? [CARDANO_MAINNET]

    // Create wallet manager with data store for cleanup on delete
    logger.debug('Creating wallet manager', {origin: 'WalletService'})
    const walletManager = yield* createWalletManager({
      walletStore,
      allChainIds: enabledChains,
      logger,
    })

    /**
     * Apply the result of a `loadCachedChainSnapshot` call: store the snapshot when
     * present, or log a warning and leave state untouched when the sync
     * produced no snapshot (no enabled accounts + nothing cached). Never
     * overwrites with an empty placeholder — that would leak through the dApp
     * connector as an empty change address and cause CBOR encoding errors.
     */
    const applySyncResult = (
      snapshot: WalletSnapshot | null,
      groupId: WalletGroupId,
      chainId: ChainId,
    ): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        if (!snapshot) {
          // Only a fault where a snapshot was expected. Midnight and the derive-only chains keep their
          // state elsewhere and never write one, so warning on those described the design once a minute
          // per chain and buried the Cardano case, which is real: no snapshot there means the rail did
          // not write one and everything reading it is stale.
          const expected = chainKeepsSnapshots(chainId)
          if (expected) {
            logger.warn('Sync produced no snapshot for a chain that keeps them — state left as it was', {
              origin: 'WalletService',
              groupId,
              chainId,
            })
          } else {
            logger.debug('No snapshot for this chain, which is how it is meant to work', {
              origin: 'WalletService',
              groupId,
              chainId,
            })
          }
          return
        }
        const key = snapshotKey(groupId, chainId, snapshot.accountIndex ?? 0)
        yield* updateState((s) => {
          const newSnapshots = new Map(s.snapshots)
          newSnapshots.set(key, snapshot)
          return {...s, snapshots: newSnapshots}
        })
      })

    // Create sync manager with real sync using createWalletSyncer
    logger.debug('Creating sync manager', {origin: 'WalletService'})
    const syncManager = yield* createSyncManager({
      syncWallet: (groupId: WalletGroupId) =>
        Effect.gen(function* () {
          yield* beginSync()

          // Sync the first chain in the group. The sync manager's `syncWallet`
          // adapter is a single-chain hook from the legacy "selected chain"
          // era; the global selection no longer carries a chain, so we no
          // longer have a notion of "the user's currently-active chain" to
          // prefer. Per-chain sync happens via syncChainWallet from the UI.
          const bridgeGroupId = groupId
          const bridgeGroup = yield* walletManager
            .getGroup(bridgeGroupId)
            .pipe(Effect.mapError((e) => new SyncError({message: `Group not found: ${e.message}`})))
          const bridgeChainId = bridgeGroup.chains.keys().next().value as ChainId

          const snapshot = yield* loadCachedChainSnapshot({
            walletManager,
            walletStore,
            groupId: bridgeGroupId,
            chainId: bridgeChainId,
          }).pipe(Effect.mapError((e) => new SyncError({message: e.message})))

          yield* applySyncResult(snapshot, bridgeGroupId, bridgeChainId)
          yield* endSync()
        }).pipe(
          Effect.catchAll((e) => {
            const errorMessage = e instanceof Error ? e.message : String(e)
            logger.error('Wallet sync failed', {
              origin: 'WalletService',
              error: errorMessage,
              cause: e,
              stack: e instanceof Error ? e.stack : undefined,
            })
            return Effect.flatMap(endSync(errorMessage), () =>
              Effect.fail(new SyncError({message: errorMessage, cause: e})),
            )
          }),
        ),
      wallets: () =>
        Effect.gen(function* () {
          // One entry per group — sync manager operates at group level
          const groups = yield* Ref.get(walletManager.groups)
          const entries = new Map<WalletGroupId, WalletGroup>()
          for (const group of groups.values()) {
            entries.set(group.groupId, group)
          }
          return entries as ReadonlyMap<WalletGroupId, WalletGroup>
        }),
      selectedWalletGroupId: () =>
        Effect.gen(function* () {
          const selection = yield* Ref.get(walletManager.selection)
          return selection ? selection.groupId : null
        }),
    })

    // Sync wallet manager refs to state
    const syncManagerState = (): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const groups = yield* Ref.get(walletManager.groups)
        const selection = yield* Ref.get(walletManager.selection)
        yield* updateState((s) => ({...s, groups, selection}))
      })

    const getState = (): Effect.Effect<WalletServiceState, never> => SubscriptionRef.get(state)

    const createWallet = (params: {
      name: string
      mnemonic: string
      chainId?: ChainId
      groupId?: string
      source?: import('@pnyx/wallet').WalletSource
    }): Effect.Effect<WalletGroup, import('@pnyx/wallet').WalletCreationError> =>
      Effect.gen(function* () {
        const chainId = params.chainId ?? CARDANO_MAINNET
        logger.debug('Creating wallet from mnemonic', {
          origin: 'WalletService',
          name: params.name,
          chainId,
        })
        const group = yield* walletManager.createFromMnemonic({
          name: params.name,
          mnemonic: params.mnemonic,
          chainId,
          ...(params.groupId ? {groupId: params.groupId as WalletGroupId} : {}),
          ...(params.source ? {source: params.source} : {}),
        })
        // Midnight receive addresses derive from role *secret* keys — no
        // xpub-only derivation exists — so they are derived exactly once, here,
        // while the mnemonic is in memory, and persisted (getReceiveAddress serves
        // them from storage). Every seed-backed wallet exposes its Midnight
        // addresses on Receive regardless of its primary chain, so this always runs
        // for createWallet (a mnemonic path).
        //
        // Every network at once, into the network-independent table: an address's
        // HRP is fixed at derivation, and after this call there is no seed to derive
        // the others from.
        yield* persistMidnightReceiveAddresses({
          store: midnightAddressTable,
          ref: {groupId: group.groupId, chainId: MIDNIGHT_MAINNET, accountIndex: 0},
          mnemonic: params.mnemonic,
          networkIds: MIDNIGHT_RECEIVE_NETWORKS,
        }).pipe(
          Effect.mapError(
            (e) =>
              new WalletCreationError({
                message: `Failed to persist Midnight receive addresses: ${getErrorMessage(e)}`,
                cause: e,
              }),
          ),
        )
        // Non-xpub-derivable companion address rows (Solana) — derived once
        // here while the mnemonic is in memory, since SOL has no public-child
        // derivation and its row is the only copy. BTC/EVM/Cardano get no row:
        // they are rebuilt on read from the account xpub persisted just below.
        // Idempotent + non-fatal: wallet creation must never fail over a
        // companion-address hiccup, so we log and continue. Runs for every
        // group regardless of the primary chain's family — a Cardano-primary
        // funds group needs its derive-only rows and xpubs just the same.
        yield* persistDeriveOnlyAddresses({
          store: walletStore,
          groupId: group.groupId,
          accountIndex: 0,
          mnemonic: params.mnemonic,
        }).pipe(
          Effect.catchAll((e) =>
            Effect.sync(() =>
              logger.warn('Failed to persist derive-only addresses', {
                origin: 'WalletService',
                error: getErrorMessage(e),
              }),
            ),
          ),
        )
        // Persist the account-level xpub (public material only) for the
        // configured + derive-only chains so addresses can later be derived
        // without the seed (BO-3). In-memory only here — the group-select /
        // create flow's save() flushes the xpub store to storage, same as the
        // Midnight xpub set by createFromMnemonic.
        const addedXpubs = yield* walletManager.ensureAccountXpubs(group.groupId, params.mnemonic)
        if (addedXpubs.length > 0) {
          logger.debug('Persisted account xpubs at import', {
            origin: 'WalletService',
            groupId: group.groupId,
            chains: addedXpubs.length,
          })
        }
        // Caller (WalletProvider) emits the user-facing "Wallet created" log
        // with totalMs + name; no need for a second one at this layer.
        yield* syncManagerState()
        return group
      })

    const restoreWallet = (params: {
      name: string
      mnemonic: string
      chainId?: ChainId
      groupId?: string
    }): Effect.Effect<WalletGroup, import('@pnyx/wallet').WalletCreationError> =>
      // Restore is the same as create - the mnemonic contains the wallet
      createWallet(params)

    const select = (selection: WalletSelection): Effect.Effect<void, import('@pnyx/wallet').WalletNotFoundError> =>
      Effect.gen(function* () {
        logger.debug('Selecting wallet', {
          origin: 'WalletService',
          groupId: selection.groupId,
          accountIndex: selection.accountIndex,
        })
        yield* walletManager.select(selection)
        yield* updateState((s) => ({...s, lastError: null}))
        yield* syncManagerState()
        // Warm every chain's cached snapshot for the group — no notion of "the
        // selected chain" to single out.
        yield* loadGroupSnapshots(selection.groupId)
      })

    const deselect = (): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        logger.debug('Deselecting wallet', {origin: 'WalletService'})
        yield* walletManager.deselect()
        yield* updateState((s) => ({
          ...s,
          selection: null,
        }))
      })

    const loadSnapshot = (
      groupId: WalletGroupId,
      chainId: ChainId,
      accountIndex = 0,
    ): Effect.Effect<WalletSnapshot | null, never> =>
      Effect.gen(function* () {
        const currentState = yield* Ref.get(state)
        const key = snapshotKey(groupId, chainId, accountIndex)
        const cached = currentState.snapshots.get(key)
        if (cached) return cached
        return yield* walletStore.loadSnapshot({groupId, chainId, accountIndex}).pipe(
          Effect.catchAll((e) => {
            logger.warn('Failed to load wallet snapshot', {
              origin: 'WalletService',
              groupId,
              chainId,
              accountIndex,
              error: String(e),
            })
            return Effect.succeed(null)
          }),
        )
      })

    // Reconstruct StoredTransaction from the TxTable's detailJson blob.
    // Kept around as a compatibility layer for legacy consumers that still
    // expect the full StoredTransaction shape. New code that only needs the
    // list-view projection should call `listTransactionRows` instead, which
    // avoids the JSON.parse entirely.
    const reconstructStored = (detailJson: string): StoredTransaction | null => {
      try {
        return JSON.parse(detailJson) as StoredTransaction
      } catch (e) {
        logger.warn('Failed to parse stored transaction detailJson', {origin: 'WalletService', error: String(e)})
        return null
      }
    }

    const loadTransaction = (
      groupId: WalletGroupId,
      chainId: ChainId,
      txHash: string,
      accountIndex = 0,
    ): Effect.Effect<StoredTransaction | null, never> =>
      walletStore.getTxRow({groupId, chainId, accountIndex}, txHash).pipe(
        Effect.map((row) => (row ? reconstructStored(row.detailJson) : null)),
        Effect.catchAll((e) => {
          logger.warn('Failed to load transaction', {
            origin: 'WalletService',
            groupId,
            chainId,
            txHash,
            error: String(e),
          })
          return Effect.succeed(null)
        }),
      )

    /**
     * Indexed list of transaction rows for the activity view.
     *
     * Returns the projection — hash, timestamp, status, type, direction,
     * amount, fee, counterparty — without touching the heavy detail blob.
     * Use this whenever the consumer doesn't need inputs/outputs/
     * certificates/metadata; reach for {@link loadTransaction} when the
     * detail screen opens.
     */
    const listTransactionRows = (
      groupId: WalletGroupId,
      chainId: ChainId,
      accountIndex = 0,
      query?: {readonly limit?: number; readonly offset?: number; readonly olderThan?: number},
    ): Effect.Effect<readonly TxListItem[], Error> =>
      walletStore.listTxRows({groupId, chainId, accountIndex, ...query}).pipe(
        // ⚠️ **Fails rather than answering with an empty list.** "This wallet has no transactions" and
        // "the store could not be read" are different facts, and a caller handed `[]` for both renders
        // the same nothing for each — the exact shape that cost a whole session on `ReceiveScreen`. It
        // is still logged here, because this is where the store error is legible.
        Effect.mapError((e) => {
          logger.warn('Failed to list transaction rows', {
            origin: 'WalletService',
            groupId,
            chainId,
            accountIndex,
            error: String(e),
          })
          return new Error(`the transaction store could not be read: ${String(e)}`)
        }),
      )

    // Global token-metadata cache (keyed by tokenId for the current network) —
    // `data` is the opaque metadata payload the portfolio enricher caches.
    const getTokenMetadata = (
      tokenIds: readonly string[],
    ): Effect.Effect<ReadonlyMap<string, {data: unknown; fetchedAt: number}>, never> =>
      tokenMetadataTable.getMany(currentNetwork, tokenIds).pipe(
        Effect.map((rows) => {
          const m = new Map<string, {data: unknown; fetchedAt: number}>()
          for (const r of rows) {
            try {
              m.set(r.tokenId, {data: JSON.parse(r.detailJson), fetchedAt: r.fetchedAt})
            } catch (e) {
              // skip a corrupt cached row — it'll be re-fetched as a miss
              logger.warn('Skipping corrupt cached token metadata row', {
                origin: 'WalletService',
                tokenId: r.tokenId,
                error: String(e),
              })
            }
          }
          return m
        }),
        Effect.catchAll((e) => {
          logger.warn('Failed to read token metadata cache', {
            origin: 'WalletService',
            tokenCount: tokenIds.length,
            error: String(e),
          })
          return Effect.succeed(new Map<string, {data: unknown; fetchedAt: number}>())
        }),
      )

    const saveTokenMetadata = (
      entries: readonly {tokenId: string; data: unknown}[],
      now: number,
    ): Effect.Effect<void, never> =>
      tokenMetadataTable
        .putMany(
          entries.map((e) => ({
            network: currentNetwork,
            tokenId: e.tokenId,
            detailJson: JSON.stringify(e.data),
            fetchedAt: now,
          })),
        )
        .pipe(
          Effect.catchAll((e) => {
            logger.warn('Failed to save token metadata', {origin: 'WalletService', error: String(e)})
            return Effect.void
          }),
        )

    // Row-form variants of the asset / token-metadata cache. The extension
    // background owns the tables, so the popup ↔ background bridge passes the
    // string-safe `AssetRow` / `TokenMetadataRow` (never the raw
    // `ChainPortfolioAsset`, whose `assetBalance` bigint can't be structured-
    // cloned). The UI converts row↔domain via `asset-row-codec`.
    const listAssetRows = (
      groupId: WalletGroupId,
      chainId: ChainId,
      accountIndex = 0,
      limit?: number,
    ): Effect.Effect<readonly AssetRow[], never> =>
      walletStore.listAssets({groupId, chainId, accountIndex, ...(limit != null ? {limit} : {})}).pipe(
        Effect.catchAll((e) => {
          logger.warn('Failed to list asset rows', {origin: 'WalletService', groupId, chainId, error: String(e)})
          return Effect.succeed([] as readonly AssetRow[])
        }),
      )

    const saveAssetRows = (
      groupId: WalletGroupId,
      chainId: ChainId,
      accountIndex: number,
      rows: readonly AssetRow[],
    ): Effect.Effect<void, never> =>
      walletStore.saveAssets({groupId, chainId, accountIndex}, rows).pipe(
        Effect.catchAll((e) => {
          logger.warn('Failed to save asset rows', {origin: 'WalletService', groupId, chainId, error: String(e)})
          return Effect.void
        }),
      )

    const getTokenMetadataRows = (tokenIds: readonly string[]): Effect.Effect<readonly TokenMetadataRow[], never> =>
      tokenMetadataTable.getMany(currentNetwork, tokenIds).pipe(
        Effect.catchAll((e) => {
          logger.warn('Failed to read token metadata rows', {
            origin: 'WalletService',
            tokenCount: tokenIds.length,
            error: String(e),
          })
          return Effect.succeed([] as readonly TokenMetadataRow[])
        }),
      )

    const saveTokenMetadataRows = (
      entries: readonly {tokenId: string; detailJson: string; fetchedAt: number}[],
    ): Effect.Effect<void, never> =>
      tokenMetadataTable.putMany(entries.map((e) => ({network: currentNetwork, ...e}))).pipe(
        Effect.catchAll((e) => {
          logger.warn('Failed to save token metadata rows', {origin: 'WalletService', error: String(e)})
          return Effect.void
        }),
      )

    const listUtxos = (
      groupId: WalletGroupId,
      chainId: ChainId,
      accountIndex = 0,
      options?: {readonly pureOnly?: boolean},
    ): Effect.Effect<readonly UtxoRow[], never> =>
      walletStore
        .listUtxos({groupId, chainId, accountIndex, ...(options?.pureOnly === true ? {pureOnly: true} : {})})
        .pipe(
          Effect.catchAll((e) => {
            logger.warn('Failed to list utxos', {
              origin: 'WalletService',
              groupId,
              chainId,
              error: String(e),
            })
            return Effect.succeed([] as readonly UtxoRow[])
          }),
        )

    const listAddresses = (
      groupId: WalletGroupId,
      chainId: ChainId,
      accountIndex = 0,
      options?: {readonly branch?: 'external' | 'internal' | 'single'; readonly isUsed?: boolean},
    ): Effect.Effect<readonly AddressRow[], never> =>
      walletStore
        .listAddresses({
          groupId,
          chainId,
          accountIndex,
          ...(options?.branch !== undefined ? {branch: options.branch} : {}),
          ...(options?.isUsed !== undefined ? {isUsed: options.isUsed} : {}),
        })
        .pipe(
          Effect.catchAll((e) => {
            logger.warn('Failed to list addresses', {
              origin: 'WalletService',
              groupId,
              chainId,
              error: String(e),
            })
            return Effect.succeed([] as readonly AddressRow[])
          }),
        )

    const listAddressesForChain = (chainId: ChainId): Effect.Effect<readonly AddressRow[], never> =>
      walletStore.listAddresses({chainId}).pipe(
        Effect.catchAll((e) => {
          logger.warn('Failed to list addresses for chain', {
            origin: 'WalletService',
            chainId,
            error: String(e),
          })
          return Effect.succeed([] as readonly AddressRow[])
        }),
      )

    const renameGroup = (groupId: WalletGroupId, name: string): Effect.Effect<void, WalletNotFoundError> =>
      Effect.gen(function* () {
        logger.debug('Renaming wallet group', {origin: 'WalletService', groupId, name})
        const found = yield* Ref.modify(walletManager.groups, (map) => {
          const group = map.get(groupId)
          if (!group) return [false, map] as const
          return [true, new Map([...map, [groupId, {...group, name}]])] as const
        })
        if (!found) return yield* Effect.fail(new WalletNotFoundError({groupId}))
        yield* syncManagerState()
      })

    const deleteGroup = (groupId: WalletGroupId): Effect.Effect<void, import('@pnyx/wallet').WalletNotFoundError> =>
      Effect.gen(function* () {
        logger.debug('Deleting wallet group', {origin: 'WalletService', groupId})

        // Remove all snapshots for this group before deletion
        const currentState = yield* Ref.get(state)
        const group = currentState.groups.get(groupId)

        yield* walletManager.deleteGroup(groupId)

        // Best-effort purge of persisted per-chain data (snapshot KV, TxTable
        // rows, UtxoTable rows, AddressTable rows). Storage failures are
        // logged but don't block deletion — the wallet is already gone from
        // the manager.
        if (group) {
          for (const [chainId, chainConfig] of group.chains) {
            for (const account of chainConfig.accounts) {
              const ref = {groupId, chainId, accountIndex: account.index}
              yield* Effect.all(
                [
                  walletStore.clearData(ref),
                  walletStore.clearTxRows(ref),
                  walletStore.clearUtxos(ref),
                  walletStore.clearAddresses(ref),
                ],
                {discard: true},
              ).pipe(
                Effect.catchAll((err) => {
                  logger.warn('Failed to purge persisted data for deleted group', {
                    origin: 'WalletService',
                    groupId,
                    chainId,
                    accountIndex: account.index,
                    error: String(err),
                  })
                  return Effect.void
                }),
              )
            }
          }
        }

        yield* updateState((s) => {
          const newSnapshots = new Map(s.snapshots)
          if (group) {
            for (const chainId of group.chains.keys()) {
              const chainConfig = group.chains.get(chainId)
              if (chainConfig) {
                for (const account of chainConfig.accounts) {
                  newSnapshots.delete(snapshotKey(groupId, chainId, account.index))
                }
              }
            }
          }
          return {...s, snapshots: newSnapshots}
        })
        yield* syncManagerState()
      })

    const enableChain = (
      groupId: WalletGroupId,
      chainId: ChainId,
      opts?: {readonly mnemonic?: string},
    ): Effect.Effect<ChainWallet, import('@pnyx/wallet').WalletCreationError | StorageError> =>
      Effect.gen(function* () {
        logger.debug('Enabling chain for group', {origin: 'WalletService', groupId, chainId})
        const group = yield* walletManager.enableChain(groupId, chainId, opts)
        // Slow-path enable hands us the mnemonic — the only later moment a
        // Midnight wallet's receive addresses can be derived + persisted
        // (idempotent; see createWallet for the primary write).
        if (opts?.mnemonic !== undefined && chainFamilyOf(chainId) === 'midnight') {
          yield* persistMidnightReceiveAddresses({
            store: midnightAddressTable,
            ref: {groupId, chainId, accountIndex: 0},
            mnemonic: opts.mnemonic,
            networkIds: MIDNIGHT_RECEIVE_NETWORKS,
          }).pipe(
            Effect.mapError(
              (e) =>
                new WalletCreationError({
                  message: `Failed to persist Midnight receive addresses: ${getErrorMessage(e)}`,
                  cause: e,
                }),
            ),
          )
        }
        yield* syncManagerState()
        const meta = toChainWallet(group, chainId)
        if (!meta) {
          return yield* Effect.fail(new StorageError({message: `Chain ${chainId} not found in group after enable`}))
        }
        return meta
      })

    const disableChain = (
      groupId: WalletGroupId,
      chainId: ChainId,
    ): Effect.Effect<void, import('@pnyx/wallet').WalletNotFoundError> =>
      Effect.gen(function* () {
        logger.debug('Disabling chain for group', {origin: 'WalletService', groupId, chainId})

        // Capture chain accounts before disabling so we can clean up snapshots
        const currentState = yield* Ref.get(state)
        const group = currentState.groups.get(groupId)

        yield* walletManager.disableChain(groupId, chainId)

        yield* updateState((s) => {
          const newSnapshots = new Map(s.snapshots)
          if (group) {
            const chainConfig = group.chains.get(chainId)
            if (chainConfig) {
              for (const account of chainConfig.accounts) {
                newSnapshots.delete(snapshotKey(groupId, chainId, account.index))
              }
            }
          }
          return {...s, snapshots: newSnapshots}
        })
        yield* syncManagerState()
      })

    const sync = (): Effect.Effect<void, SyncError> =>
      Effect.gen(function* () {
        const selection = yield* Ref.get(walletManager.selection)
        if (selection) {
          logger.debug('Starting wallet sync', {origin: 'WalletService', groupId: selection.groupId})
          yield* syncManager.syncWallet(selection.groupId)
          logger.debug('Wallet sync completed', {origin: 'WalletService', groupId: selection.groupId})
        } else {
          logger.warn('Sync requested but no wallet selected', {origin: 'WalletService'})
        }
      })

    // Dedup concurrent syncs — multiple React effects (group switch, restore,
    // pull-to-refresh) can trigger syncChainWallet for the same group+chain
    // within milliseconds. Without dedup, each creates an independent pipeline
    // that hits filterUsed, utxoForAddresses, account/state etc. redundantly.
    const syncInFlight = new Map<string, Promise<void>>()

    const syncChainWallet = (
      groupId: WalletGroupId,
      chainId: ChainId,
      options?: {txMode?: TxFetchMode},
    ): Effect.Effect<void, SyncError> => {
      // Default to 'all' to match loadCachedChainSnapshot's own default when no
      // txMode is passed; keying it 'recent' would split a full sync from an
      // explicit 'all' into two un-coalesced runs.
      const mode = options?.txMode ?? TX_FETCH_MODE.ALL
      const dedupKey = syncDedupKey(groupId, chainId, mode)
      // ⚠️ A `recent` request joins an in-flight `all` — see `sync-dedup`. Keyed
      // strictly by mode, the two callers that fire on every launch (the group
      // selection effect asking for `recent`, the chain-sync scheduler's first
      // tick asking for `all`) ran two whole pipelines over one wallet.
      const coveringKey = coveringSyncKey({groupId, chainId, mode}, syncInFlight)
      const existing = coveringKey === null ? undefined : syncInFlight.get(coveringKey)
      if (existing) {
        logger.debug('Chain wallet sync dedup — joining in-flight', {
          origin: 'WalletService',
          groupId,
          chainId,
          asked: mode,
          joined: coveringKey,
        })
        // Mirror beginSync/endSync so isSyncing reflects all concurrent consumers.
        return Effect.gen(function* () {
          yield* beginSync()
          yield* Effect.tryPromise({
            try: () => existing,
            catch: (e) => new SyncError({message: e instanceof Error ? e.message : String(e), cause: e}),
          })
          yield* endSync()
        }).pipe(
          Effect.catchAll((e) => {
            return Effect.flatMap(endSync(e instanceof SyncError ? e.message : String(e)), () => Effect.fail(e))
          }),
        )
      }

      const effect = Effect.gen(function* () {
        logger.debug('Starting chain wallet sync', {origin: 'WalletService', groupId, chainId, txMode: options?.txMode})

        yield* beginSync()

        const snapshot = yield* loadCachedChainSnapshot({
          walletManager,
          walletStore,
          groupId,
          chainId,
          ...(options?.txMode ? {txMode: options.txMode} : {}),
        }).pipe(
          // Retry transient storage blips before the failure escapes the sync.
          // Placed inside the syncWalletForChain pipe so the beginSync/endSync
          // counter pair around it runs exactly once per call.
          Effect.retry(TRANSIENT_STORAGE_SYNC_RETRY),
          Effect.mapError((e) => new SyncError({message: e.message})),
        )

        yield* applySyncResult(snapshot, groupId, chainId)
        yield* endSync()

        logger.debug('Chain wallet sync completed', {origin: 'WalletService', groupId, chainId})
      }).pipe(
        Effect.catchAll((e) => {
          const errorMessage = e instanceof Error ? e.message : String(e)
          logger.error('Chain wallet sync failed', {origin: 'WalletService', groupId, chainId, error: errorMessage})
          return Effect.flatMap(endSync(errorMessage), () =>
            Effect.fail(new SyncError({message: errorMessage, cause: e})),
          )
        }),
      )

      // Run the Effect once, cache the resulting Promise for concurrent callers.
      const promise = Effect.runPromise(effect).finally(() => syncInFlight.delete(dedupKey))
      syncInFlight.set(dedupKey, promise)

      return Effect.tryPromise({
        try: () => promise,
        catch: (e) => new SyncError({message: e instanceof Error ? e.message : String(e), cause: e}),
      })
    }

    const syncChain = (chainId: ChainId): Effect.Effect<void, SyncError> =>
      Effect.gen(function* () {
        const selection = yield* Ref.get(walletManager.selection)
        if (!selection) {
          logger.warn('Sync requested but no wallet selected', {origin: 'WalletService'})
          return
        }

        logger.debug('Starting chain sync', {origin: 'WalletService', groupId: selection.groupId, chainId})

        const snapshot = yield* loadCachedChainSnapshot({
          walletManager,
          walletStore,
          groupId: selection.groupId,
          chainId,
        }).pipe(Effect.mapError((e) => new SyncError({message: getErrorMessage(e)})))

        yield* applySyncResult(snapshot, selection.groupId, chainId)

        logger.debug('Chain sync completed', {origin: 'WalletService', groupId: selection.groupId, chainId})
      })

    const save = (): Effect.Effect<void, import('@pnyx/wallet').StorageError> => {
      logger.debug('Saving wallet state', {origin: 'WalletService'})
      return walletManager.save().pipe(Effect.provide(storageLayerForPersistence))
    }

    /**
     * Write back the address rows that nothing else can rebuild.
     *
     * ⚠️ **The address table drops and recreates itself on a schema-version mismatch**
     * — there is no migration framework, by design — and its own doc says chain sync
     * repopulates it afterwards. That is true only for wallets whose addresses are
     * *derived*: an HD wallet's book comes back from its xpub. A shared wallet's
     * compiled script address and a watch-only import were written once at creation and
     * never again, so the first bump would have left those wallets with no Cardano
     * address at all — and receive, the co-sign screen and the rail all resolve theirs
     * from storage.
     *
     * ⚠️ **Writes only rows that are missing.** `upsert` replaces by
     * (group, chain, account, branch, index), so restoring unconditionally would reset
     * `isUsed` on every load — and for a watch-only wallet that flag is the whole
     * reason its single address is in the book.
     */
    const restoreNonDerivedAddresses: Effect.Effect<void, never> = Effect.gen(function* () {
      const groups = yield* Ref.get(walletManager.groups)
      const rows: AddressRow[] = []
      for (const {groupId, chainId, index, human, source} of nonDerivedAddresses(groups)) {
        const ref = {groupId, chainId, accountIndex: 0}
        const existing = yield* walletStore.getAddress(ref, 'external', index).pipe(
          Effect.catchAll((e) =>
            Effect.sync(() => {
              // ⚠️ A failed read is not an absent row. Answer "present" so a store that
              // will not answer never leads to writing over something we could not see.
              logger.warn('Could not check a non-derived address row; leaving it alone', {
                origin: 'WalletService',
                groupId,
                chainId,
                index,
                error: String(e),
              })
              return {human} as AddressRow
            }),
          ),
        )
        if (existing !== null) continue
        rows.push({
          ...ref,
          branch: 'external' as const,
          index,
          human,
          hash: addressRowHash(human, `${source} wallet address`),
          // A restored row claims existence, never history: discovery and the history
          // walk own `isUsed`, and this path only runs when the row is gone.
          isUsed: false,
        })
      }
      if (rows.length === 0) return
      yield* walletStore.upsertAddresses(rows).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            logger.info('Restored address rows that only the group record could rebuild', {
              origin: 'WalletService',
              rows: rows.length,
            })
          }),
        ),
        Effect.catchAll((e) =>
          Effect.sync(() => {
            logger.warn('Could not restore non-derived address rows; those wallets may have no address', {
              origin: 'WalletService',
              rows: rows.length,
              error: String(e),
            })
          }),
        ),
      )
    })

    const load = (): Effect.Effect<void, import('@pnyx/wallet').StorageError> =>
      Effect.gen(function* () {
        logger.debug('Loading wallet state', {origin: 'WalletService'})
        yield* walletManager.load().pipe(Effect.provide(storageLayerForPersistence))
        yield* syncManagerState()
        yield* restoreNonDerivedAddresses

        // Warm every chain's snapshot for the selected group — chain-specific
        // warmup would require a "selected chain" notion we no longer carry.
        const selection = yield* Ref.get(walletManager.selection)
        if (selection) {
          yield* loadGroupSnapshots(selection.groupId)
        }

        logger.debug('Wallet state loaded', {origin: 'WalletService'})
      })

    /** Helper to get the selected snapshot key and snapshot. */
    // Address reads that fall through to derivation when storage fails. Absence
    // is a `null` row; only a real store failure lands here, so it is logged —
    // a swallowed read made "no address stored" and "the table would not open"
    // render identically.
    const cachedAddressRow = (
      ref: {readonly groupId: WalletGroupId; readonly chainId: ChainId; readonly accountIndex: number},
      branch: 'external' | 'internal' | 'single',
      index: number,
      purpose: string,
    ): Effect.Effect<AddressRow | null, never> =>
      walletStore.getAddress(ref, branch, index).pipe(
        Effect.catchAll((e) => {
          logger.warn('Failed to read cached address', {
            origin: 'WalletService',
            purpose,
            groupId: ref.groupId,
            chainId: ref.chainId,
            accountIndex: ref.accountIndex,
            branch,
            index,
            error: String(e),
          })
          return Effect.succeed(null)
        }),
      )

    const listAddressRows = (
      query: Parameters<WalletDataStore['listAddresses']>[0],
      purpose: string,
    ): Effect.Effect<readonly AddressRow[], never> =>
      walletStore.listAddresses(query).pipe(
        Effect.catchAll((e) => {
          logger.warn('Failed to list addresses', {
            origin: 'WalletService',
            purpose,
            groupId: query.groupId,
            chainId: query.chainId,
            accountIndex: query.accountIndex,
            branch: query.branch,
            error: String(e),
          })
          return Effect.succeed([] as readonly AddressRow[])
        }),
      )

    /**
     * Repair path for wallets whose Midnight rows predate network keying — see the
     * method's doc on the service interface. Idempotent, so callers can fire it on
     * every sync without checking first.
     */
    const ensureMidnightReceiveAddresses = (params: {
      readonly groupId: WalletGroupId
      readonly mnemonic: string
      readonly accountIndex?: number
    }): Effect.Effect<readonly string[], SyncError> =>
      persistMidnightReceiveAddresses({
        store: midnightAddressTable,
        ref: {
          groupId: params.groupId,
          chainId: MIDNIGHT_MAINNET,
          accountIndex: params.accountIndex ?? 0,
        },
        mnemonic: params.mnemonic,
        networkIds: MIDNIGHT_RECEIVE_NETWORKS,
      }).pipe(
        Effect.tap((written) =>
          Effect.sync(() => {
            // Logged either way: "wrote nothing" means the set was already complete,
            // which is a different fact from never having run.
            logger.debug('Midnight receive addresses ensured', {
              origin: 'WalletService',
              groupId: params.groupId,
              written: written.join(',') || 'none missing',
            })
          }),
        ),
        Effect.mapError(
          (e) => new SyncError({message: `Failed to ensure Midnight receive addresses: ${getErrorMessage(e)}`}),
        ),
      )

    const getReceiveAddress = (params?: {
      readonly groupId?: WalletGroupId
      readonly chainId?: ChainId
      readonly accountIndex?: number
      readonly addressIndex?: number
    }): Effect.Effect<string, SyncError> =>
      Effect.gen(function* () {
        const currentState = yield* Ref.get(state)

        // chainId is per-screen — must be provided. The groupId can fall
        // back to the user's currently-selected group; the chain cannot.
        const groupId = params?.groupId ?? currentState.selection?.groupId
        const chainId = params?.chainId
        if (!groupId || !chainId) {
          return yield* Effect.fail(new SyncError({message: 'getReceiveAddress requires groupId and chainId'}))
        }

        const group = currentState.groups.get(groupId)
        if (!group) return yield* Effect.fail(new SyncError({message: `Group ${groupId} not found`}))

        const chainConfig = group.chains.get(chainId)
        const resolvedAccountIndex = params?.accountIndex ?? chainConfig?.selectedAccountIndex ?? 0
        const addressIndex = params?.addressIndex ?? 0

        // Fast path: address already in the AddressTable from a previous sync.
        const ref = {groupId, chainId, accountIndex: resolvedAccountIndex}

        // Midnight first, and from its own table: fixed `single`-branch slots per
        // account (night 0, dust 1, shielded 2) derived from role secret keys at
        // wallet creation. Served from storage only — no xpub-only derivation exists
        // — and `addressIndex` selects the slot.
        //
        // Ahead of the generic cached reads on purpose: those look in the
        // *per-network* table, where a wallet created before the rows were
        // network-keyed still has a set encoded for whichever network was active
        // then. Serving that would hand out an address of the wrong network, which
        // the indexer rejects — the failure this keying exists to stop.
        if (chainFamilyOf(chainId) === 'midnight') {
          return yield* getStoredMidnightReceiveAddress(
            midnightAddressTable,
            ref,
            midnightNetworkIdForNetwork(currentNetwork),
            addressIndex,
          ).pipe(Effect.mapError((e) => new SyncError({message: getErrorMessage(e)})))
        }
        // Single-row chains store the canonical address as `branch='single'`;
        // HD chains use `branch='external'` indexed by derivation index. Cardano
        // is HD: its book is owned by discovery, so the receive address is
        // `external[0]` — skip the single slot (which import no longer writes)
        // and fall through to external, then the xpub generator below.
        const isCardano = chainFamilyOf(chainId) === 'cardano'
        const cachedSingle =
          !isCardano && addressIndex === 0 ? yield* cachedAddressRow(ref, 'single', 0, 'getReceiveAddress') : null
        if (cachedSingle?.human) return cachedSingle.human
        const cachedExternal = yield* cachedAddressRow(ref, 'external', addressIndex, 'getReceiveAddress')
        if (cachedExternal?.human) return cachedExternal.human

        // Slow path: address not cached.
        // Derive the receive address directly from the account XPub — pure offline, no network calls.
        const accountXPub = yield* walletManager
          .getXPub(groupId, chainId, resolvedAccountIndex)
          .pipe(
            Effect.mapError(
              (e) => new SyncError({message: e instanceof Error ? e.message : `Failed to get XPub for ${chainId}`}),
            ),
          )
        const isHardware = group.isHardware === true
        const generator = yield* createAddressGeneratorForChain(accountXPub, chainId, currentState.network, {
          isHardware,
        }).pipe(
          Effect.mapError(
            (e) =>
              new SyncError({
                message: e instanceof Error ? e.message : `Failed to create address generator for ${chainId}`,
              }),
          ),
        )
        return yield* generator
          .derive(0, addressIndex)
          .pipe(
            Effect.mapError(
              (e) =>
                new SyncError({message: e instanceof Error ? e.message : `Failed to derive address for ${chainId}`}),
            ),
          )
      })

    const loadGroupSnapshots = (groupId: WalletGroupId): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const groups = yield* Ref.get(walletManager.groups)
        const group = groups.get(groupId)
        if (!group) return

        // Load snapshots for each chain + enabled account in the group
        const loadTasks: Effect.Effect<{key: SnapshotKey; snapshot: WalletSnapshot | null}, never>[] = []
        for (const [chainId, chainConfig] of group.chains.entries()) {
          for (const account of chainConfig.accounts) {
            if (!account.enabled) continue
            const key = snapshotKey(groupId, chainId, account.index)
            loadTasks.push(
              walletStore.loadSnapshot({groupId, chainId, accountIndex: account.index}).pipe(
                Effect.map((snapshot) => ({key, snapshot})),
                Effect.catchAll((e) => {
                  logger.warn('Failed to load snapshot for group chain', {
                    origin: 'WalletService',
                    groupId,
                    chainId,
                    accountIndex: account.index,
                    error: String(e),
                  })
                  return Effect.succeed({key, snapshot: null})
                }),
              ),
            )
          }
        }

        const loaded = yield* Effect.all(loadTasks, {concurrency: 'unbounded'})

        yield* updateState((s) => {
          const newSnapshots = new Map(s.snapshots)
          for (const {key, snapshot} of loaded) {
            if (snapshot && !newSnapshots.has(key)) {
              newSnapshots.set(key, snapshot)
            }
          }
          return {...s, snapshots: newSnapshots}
        })
      })

    // Stake address is Cardano-only — hard-code chain so the API stays
    // parameter-free for the Cardano-only callers (staking flows, dApp
    // connector). EVM/Solana/UTXO chains have no staking concept here.
    const getStakeAddress = (): Effect.Effect<string, SyncError> =>
      Effect.gen(function* () {
        const currentState = yield* Ref.get(state)
        const selection = currentState.selection
        if (!selection) {
          return yield* Effect.fail(new SyncError({message: 'No wallet selected'}))
        }

        const key = snapshotKey(selection.groupId, CARDANO_MAINNET, selection.accountIndex)
        const snapshot = currentState.snapshots.get(key)
        if (!snapshot) {
          return yield* Effect.fail(new SyncError({message: 'Wallet not synced'}))
        }

        if (!snapshot.powers?.staking?.human) {
          return yield* Effect.fail(new SyncError({message: 'Stake address not available'}))
        }
        return snapshot.powers.staking.human
      })

    const getChangeAddress = (params?: {
      readonly groupId?: WalletGroupId
      readonly chainId?: ChainId
      readonly accountIndex?: number
    }): Effect.Effect<string, SyncError> =>
      Effect.gen(function* () {
        const currentState = yield* Ref.get(state)

        // chainId is per-screen — must be provided by the caller. The
        // groupId can fall back to the user's currently-selected group.
        const sel = currentState.selection
        const groupId = params?.groupId ?? sel?.groupId
        const chainId = params?.chainId
        if (!groupId || !chainId) {
          return yield* Effect.fail(new SyncError({message: 'getChangeAddress requires groupId and chainId'}))
        }
        const accountIndex = params?.accountIndex ?? (sel && groupId === sel.groupId ? sel.accountIndex : 0)

        // Try the AddressTable first (cheap, no derivation needed).
        const ref = {groupId, chainId, accountIndex}
        const single = yield* cachedAddressRow(ref, 'single', 0, 'getChangeAddress')
        if (single?.human) return single.human
        const firstExternal = yield* cachedAddressRow(ref, 'external', 0, 'getChangeAddress')
        if (firstExternal?.human) return firstExternal.human

        // Fallback: derive offline from the account XPub (role=0, index=0).
        // Always available — XPub is stored at import time for all wallet types.
        const group = currentState.groups.get(groupId)
        const isHardware = group?.isHardware === true
        const accountXPub = yield* walletManager
          .getXPub(groupId, chainId, accountIndex)
          .pipe(Effect.mapError((e) => new SyncError({message: e instanceof Error ? e.message : 'Failed to get XPub'})))
        const generator = yield* createAddressGeneratorForChain(accountXPub, chainId, currentState.network, {
          isHardware,
        }).pipe(
          Effect.mapError(
            (e) => new SyncError({message: e instanceof Error ? e.message : 'Failed to create address generator'}),
          ),
        )
        return yield* generator
          .derive(0, 0)
          .pipe(
            Effect.mapError(
              (e) => new SyncError({message: e instanceof Error ? e.message : 'Failed to derive address'}),
            ),
          )
      })

    // The CIP-30 dApp connector and the Cardano-only address helpers below
    // need a "selected snapshot / ref". They are Cardano-anchored by design
    // (dApp connector is CIP-30; only Cardano), so we pin chainId to
    // CARDANO_MAINNET here rather than carrying a chain in global selection.
    const getSelectedSnapshot = (): Effect.Effect<WalletSnapshot | null, never> =>
      Effect.gen(function* () {
        const currentState = yield* Ref.get(state)
        const sel = currentState.selection
        if (!sel) return null
        const key = snapshotKey(sel.groupId, CARDANO_MAINNET, sel.accountIndex)
        return currentState.snapshots.get(key) ?? null
      })

    const selectedRef = (): Effect.Effect<{groupId: WalletGroupId; chainId: ChainId; accountIndex: number} | null> =>
      Effect.gen(function* () {
        const currentState = yield* Ref.get(state)
        const sel = currentState.selection
        if (!sel) return null
        return {groupId: sel.groupId, chainId: CARDANO_MAINNET, accountIndex: sel.accountIndex}
      })

    const getUsedAddresses = (): Effect.Effect<readonly string[], never> =>
      Effect.gen(function* () {
        const ref = yield* selectedRef()
        if (!ref) return []
        return yield* listAddressRows({...ref, branch: 'external', isUsed: true}, 'getUsedAddresses').pipe(
          Effect.map((rows) => rows.map((r) => r.human)),
        )
      })

    const getUnusedAddresses = (): Effect.Effect<readonly string[], never> =>
      Effect.gen(function* () {
        const ref = yield* selectedRef()
        if (!ref) return []
        return yield* listAddressRows({...ref, branch: 'external', isUsed: false}, 'getUnusedAddresses').pipe(
          Effect.map((rows) => rows.map((r) => r.human)),
        )
      })

    const getUsedAddressesIndexed = (): Effect.Effect<
      readonly {readonly address: string; readonly index: number}[],
      never
    > =>
      Effect.gen(function* () {
        const ref = yield* selectedRef()
        if (!ref) return []
        return yield* listAddressRows({...ref, branch: 'external', isUsed: true}, 'getUsedAddressesIndexed').pipe(
          Effect.map((rows) => rows.map((r) => ({address: r.human, index: r.index}))),
        )
      })

    const getUnusedAddressesIndexed = (): Effect.Effect<
      readonly {readonly address: string; readonly index: number}[],
      never
    > =>
      Effect.gen(function* () {
        const ref = yield* selectedRef()
        if (!ref) return []
        return yield* listAddressRows({...ref, branch: 'external', isUsed: false}, 'getUnusedAddressesIndexed').pipe(
          Effect.map((rows) => rows.map((r) => ({address: r.human, index: r.index}))),
        )
      })

    const getInternalAddressesIndexed = (): Effect.Effect<
      readonly {readonly address: string; readonly index: number}[],
      never
    > =>
      Effect.gen(function* () {
        const ref = yield* selectedRef()
        if (!ref) return []
        return yield* listAddressRows({...ref, branch: 'internal'}, 'getInternalAddressesIndexed').pipe(
          Effect.map((rows) => rows.map((r) => ({address: r.human, index: r.index}))),
        )
      })

    const cacheAccountXPub = (params: {
      groupId: WalletGroupId
      chainId: ChainId
      publicKey: Uint8Array
      chainCode: Uint8Array
      accountIndex?: number
    }): Effect.Effect<void, import('@pnyx/wallet').WalletCreationError> =>
      Effect.gen(function* () {
        logger.debug('Caching account XPub', {
          origin: 'WalletService',
          groupId: params.groupId,
          chainId: params.chainId,
          publicKeyLength: params.publicKey.length,
          chainCodeLength: params.chainCode.length,
          accountIndex: params.accountIndex ?? 0,
        })
        yield* walletManager.cacheAccountXPub(params)
      })

    const switchNetwork = (network: Network): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        if (network === currentNetwork) return

        logger.info('Switching network', {origin: 'WalletService', from: currentNetwork, to: network})

        // Close old store
        yield* store.close().pipe(
          Effect.catchAll((e) => {
            logger.warn('Failed to close store', {origin: 'WalletService', error: String(e)})
            return Effect.void
          }),
        )
        yield* txTable.close().pipe(
          Effect.catchAll((e) => {
            logger.warn('Failed to close tx-table', {origin: 'WalletService', error: String(e)})
            return Effect.void
          }),
        )
        yield* utxoTable.close().pipe(
          Effect.catchAll((e) => {
            logger.warn('Failed to close utxo-table', {origin: 'WalletService', error: String(e)})
            return Effect.void
          }),
        )
        yield* addressTable.close().pipe(
          Effect.catchAll((e) => {
            logger.warn('Failed to close address-table', {origin: 'WalletService', error: String(e)})
            return Effect.void
          }),
        )
        yield* assetsTable.close().pipe(
          Effect.catchAll((e) => {
            logger.warn('Failed to close assets-table', {origin: 'WalletService', error: String(e)})
            return Effect.void
          }),
        )
        yield* tokenMetadataTable.close().pipe(
          Effect.catchAll((e) => {
            logger.warn('Failed to close token-metadata-table', {origin: 'WalletService', error: String(e)})
            return Effect.void
          }),
        )
        yield* tokenPricesTable.close().pipe(
          Effect.catchAll((e) => {
            logger.warn('Failed to close token-prices-table', {origin: 'WalletService', error: String(e)})
            return Effect.void
          }),
        )
        yield* pricePointTable.close().pipe(
          Effect.catchAll((e) => {
            logger.warn('Failed to close price-point-table', {origin: 'WalletService', error: String(e)})
            return Effect.void
          }),
        )

        // Open new store + tx-table + utxo-table + address-table + assets-table for the new network
        currentNetwork = network
        store = yield* storeFactory(network)
        txTable = yield* txTableFactory(network)
        utxoTable = yield* utxoTableFactory(network)
        addressTable = yield* addressTableFactory(network)
        assetsTable = yield* assetsTableFactory(network)
        tokenMetadataTable = yield* tokenMetadataTableFactory(network)
        tokenPricesTable = yield* tokenPricesTableFactory(network)
        pricePointTable = yield* pricePointTableFactory(network)
        walletStore = createWalletDataStore(store, txTable, utxoTable, addressTable, assetsTable)
        setCardanoDataStore(walletStore)
        setCardanoAssetsTokenStore(tokenMetadataTable)
        setCardanoAssetsPriceStore(tokenPricesTable)
        setPricePointStore(pricePointTable)

        // Reset snapshots — the selected group's per-chain snapshots are
        // warmed below by loadGroupSnapshots(groupId) (which loops every
        // enabled chain). Pre-warming a single chain here would require a
        // notion of "the selected chain" we no longer carry.
        yield* updateState((s) => ({
          ...s,
          network,
          snapshots: new Map<SnapshotKey, WalletSnapshot>(),
          isSyncing: false,
          lastError: null,
        }))

        const selection = yield* Ref.get(walletManager.selection)
        if (selection) {
          yield* loadGroupSnapshots(selection.groupId)
        }

        logger.info('Network switched', {origin: 'WalletService', network})
      }).pipe(
        Effect.catchAll((e) => {
          logger.error('Failed to switch network', {origin: 'WalletService', error: String(e)})
          return Effect.void
        }),
      )

    const getNetworkId = (): Effect.Effect<number, never> => Effect.succeed(currentNetwork === 'mainnet' ? 1 : 0)

    const close = (): Effect.Effect<void, never> =>
      store.close().pipe(
        Effect.catchAll((e) => {
          logger.warn('Failed to close store', {origin: 'WalletService', error: String(e)})
          return Effect.void
        }),
      )

    const getDeriveOnlyAddresses = (
      groupId: WalletGroupId,
      accountIndex = 0,
    ): Effect.Effect<Partial<DeriveOnlyAddresses>, SyncError> =>
      Effect.gen(function* () {
        const currentState = yield* Ref.get(state)
        // Seedless resolution: stored row, else xpub-derived, else a prompt-free
        // backfill. The vault / mnemonic is unreachable here, so no biometric
        // prompt fires on this path.
        // Read-only resolution from storage (stored row, else xpub-rebuild).
        // Xpubs are persisted at create/restore (ensureAccountXpubs), so there is
        // no lazy backfill here — a missing address surfaces as an absent chain
        // rather than being silently healed.
        const {addresses} = yield* resolveDeriveOnlyAddresses({
          store: walletStore,
          groupId,
          accountIndex,
          network: currentState.network,
          getXpub: (chainId) =>
            walletManager.getXPub(groupId, chainId, accountIndex).pipe(
              Effect.map((x): Uint8Array | null => x),
              Effect.catchAll((e) => {
                // ⚠️ A watch-only wallet has no xpub for any chain — that is what watch-only means, so
                // it is an expected absence rather than a failure to recover from. It was warning once
                // per derive-only chain per sync (six lines a launch for one imported account), which
                // is how a real warning gets lost. Level by intent: `debug` for "there is none",
                // `warn` kept for a read that actually failed.
                const missing = String(e).includes('WalletNotFoundError')
                const log = missing ? logger.debug : logger.warn
                log(missing ? 'No account xpub for a derive-only chain, as expected' : 'Account xpub read failed', {
                  origin: 'WalletService',
                  groupId,
                  chainId,
                  accountIndex,
                  error: String(e),
                })
                return Effect.succeed(null)
              }),
            ),
        })
        return addresses
      }).pipe(
        Effect.mapError((e) => new SyncError({message: `Failed to read derive-only addresses: ${getErrorMessage(e)}`})),
      )

    const discoverCardanoAddresses = (
      groupId: WalletGroupId,
      network: CardanoAddress.Network,
      probe: CardanoUsageProbe,
      accountIndex = 0,
      options?: CardanoDiscoveryOptions,
    ): Effect.Effect<readonly string[], SyncError> =>
      Effect.gen(function* () {
        const xpub = yield* walletManager.getXPub(groupId, CARDANO_MAINNET, accountIndex).pipe(
          Effect.map(Option.some<Uint8Array>),
          Effect.catchAll((e) => {
            logger.warn('Failed to read Cardano account xpub', {
              origin: 'WalletService',
              groupId,
              accountIndex,
              error: String(e),
            })
            return Effect.succeed(Option.none<Uint8Array>())
          }),
        )
        if (Option.isNone(xpub)) {
          // No Cardano account xpub — cannot run seedless discovery. Xpubs are
          // persisted at create/restore, so this should not happen; surface it
          // as an empty book (rail primary-only) rather than silently healing.
          logger.warn('Cardano discovery skipped: no account xpub in storage', {origin: 'WalletService', groupId})
          return []
        }
        const {knownAddresses} = yield* discoverAndPersistCardanoAddresses({
          accountXpubHex: hex.encode(xpub.value),
          network,
          ref: {groupId, chainId: CARDANO_MAINNET, accountIndex},
          probe,
          upsert: walletStore.upsertAddresses,
          ...(options?.alreadyUsed !== undefined ? {alreadyUsed: options.alreadyUsed} : {}),
          ...(options?.anyUsed !== undefined ? {anyUsed: options.anyUsed} : {}),
          ...(options?.seenAmong !== undefined ? {seenAmong: options.seenAmong} : {}),
        }).pipe(Effect.mapError((e) => new SyncError({message: `Cardano discovery failed: ${getErrorMessage(e)}`})))
        return knownAddresses
      })

    const createSharedWalletGroup = (params: {
      readonly groupId: string
      readonly name: string
      readonly addresses: readonly string[]
      readonly checksumSeed?: string
    }): Effect.Effect<WalletGroup, SyncError> =>
      Effect.gen(function* () {
        const primary = params.addresses[0]
        if (primary === undefined) {
          return yield* Effect.fail(new SyncError({message: 'Shared wallet requires at least one address'}))
        }
        const group = yield* walletManager
          .createReadOnly({
            name: params.name,
            addresses: params.addresses,
            chainId: CARDANO_MAINNET,
            groupId: params.groupId as WalletGroupId,
            source: 'multisig',
            ...(params.checksumSeed ? {checksumSeed: params.checksumSeed} : {}),
          })
          .pipe(
            Effect.mapError((e) => new SyncError({message: `Failed to register shared wallet: ${getErrorMessage(e)}`})),
          )
        // The first script address, persisted as `external[0]`. A shared wallet
        // has no xpub to rebuild an address from, so without the row every
        // reader that resolves an address from storage — receive, the co-sign
        // screen — finds a wallet with no Cardano address at all.
        const ref = {groupId: group.groupId, chainId: CARDANO_MAINNET, accountIndex: 0}
        yield* walletStore
          .upsertAddresses([
            {
              ...ref,
              branch: 'external' as const,
              index: 0,
              human: primary,
              hash: addressRowHash(primary, 'shared wallet script address'),
              isUsed: false,
            },
          ])
          .pipe(
            Effect.mapError(
              (e) => new SyncError({message: `Failed to persist shared wallet address: ${getErrorMessage(e)}`}),
            ),
          )
        // ⚠️ Without this the group exists in the manager and on disk, and the UI
        // never sees it: `groups` is read from *this service's* state ref, so a
        // creator that does not fold the manager's groups back into it leaves the
        // wallet list a restart behind. A shared wallet was created, saved, and
        // then absent from the switcher until the app was relaunched.
        yield* syncManagerState()
        return group
      })

    const createReadOnlyCardanoWallet = (params: {
      readonly name: string
      readonly addresses: readonly string[]
      readonly checksumSeed?: string
    }): Effect.Effect<WalletGroup, SyncError> =>
      Effect.gen(function* () {
        const primary = params.addresses[0]
        if (primary === undefined) {
          return yield* Effect.fail(new SyncError({message: 'Read-only wallet requires at least one address'}))
        }
        const group = yield* walletManager
          .createReadOnly({
            name: params.name,
            addresses: params.addresses,
            chainId: CARDANO_MAINNET,
            ...(params.checksumSeed ? {checksumSeed: params.checksumSeed} : {}),
          })
          .pipe(
            Effect.mapError(
              (e) => new SyncError({message: `Failed to create read-only wallet: ${getErrorMessage(e)}`}),
            ),
          )
        // Persist only the primary as `external[0]` — enough to bootstrap the
        // rail (getDeriveOnlyAddresses reads it); the live balance comes from the
        // account-level UTxO endpoint and history derives its own address set, so
        // there's no need to store the (potentially thousands of) other addresses.
        const ref = {groupId: group.groupId, chainId: CARDANO_MAINNET, accountIndex: 0}
        const rows: readonly AddressRow[] = [
          {
            ...ref,
            branch: 'external' as const,
            index: 0,
            human: primary,
            hash: addressRowHash(primary, 'watch-only address'),
            isUsed: true,
          },
        ]
        yield* walletStore
          .upsertAddresses(rows)
          .pipe(
            Effect.mapError(
              (e) => new SyncError({message: `Failed to persist read-only addresses: ${getErrorMessage(e)}`}),
            ),
          )
        // The same reason as `createSharedWalletGroup` above: the wallet list reads
        // this service's state ref, not the manager's, so a watch-only wallet was
        // equally invisible until the next launch.
        yield* syncManagerState()
        return group
      })

    const persistDeviceDeriveOnlyAddressFn = (params: {
      readonly groupId: string
      readonly chain: DeriveOnlyChain
      readonly accountIndex: number
      readonly address: string
    }): Effect.Effect<void, SyncError> =>
      persistDeviceDeriveOnlyAddress({store: walletStore, ...params}).pipe(
        Effect.asVoid,
        Effect.mapError((e) => new SyncError({message: `Failed to persist device address: ${getErrorMessage(e)}`})),
      )

    return {
      state,
      walletManager,
      getState,
      createWallet,
      restoreWallet,
      select,
      deselect,
      loadSnapshot,
      loadTransaction,
      listTransactionRows,
      getTokenMetadata,
      saveTokenMetadata,
      listAssetRows,
      saveAssetRows,
      getTokenMetadataRows,
      saveTokenMetadataRows,
      listUtxos,
      listAddresses,
      listAddressesForChain,
      renameGroup,
      deleteGroup,
      enableChain,
      disableChain,
      sync,
      syncChainWallet,
      syncChain,
      getSelectedSnapshot,
      save,
      load,
      getReceiveAddress,
      ensureMidnightReceiveAddresses,
      getDeriveOnlyAddresses,
      discoverCardanoAddresses,
      createReadOnlyCardanoWallet,
      createSharedWalletGroup,
      persistDeviceDeriveOnlyAddress: persistDeviceDeriveOnlyAddressFn,
      loadGroupSnapshots,
      getChangeAddress,
      getStakeAddress,
      getUsedAddresses,
      getUnusedAddresses,
      getUsedAddressesIndexed,
      getUnusedAddressesIndexed,
      getInternalAddressesIndexed,
      cacheAccountXPub,
      updateSource: (groupId: import('@pnyx/wallet').WalletGroupId, source: import('@pnyx/wallet').WalletSource) =>
        walletManager.updateSource(groupId, source),
      switchNetwork,
      getNetworkId,
      close,
    }
  })

/**
 * Create WalletService layer with the specified configuration.
 */
export const WalletServiceLayer = (config: WalletServiceConfig) =>
  Layer.effect(WalletService, createWalletService(config))
