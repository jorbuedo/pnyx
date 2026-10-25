/**
 * @pnyx/wallet
 *
 * Core wallet functionality for multi-chain applications.
 *
 * Provides account management, UTXO tracking, transaction history,
 * and synchronization with blockchains.
 *
 * @module
 */

// Account
export {createAccount, createAddressChain, DEFAULT_GAP_LIMIT} from './account/account.js'
export {type AddressDiscoveryResult, discoverAddresses} from './account/address-chain.js'
export {
  type Address,
  type AddressGenerator,
  type AddressRole,
  createAddressGeneratorForChain,
} from './account/address-generator.js'
export {deriveBitcoinAddress, deriveBitcoinAddressFromMnemonic} from './account/derivation/bitcoin.js'
export {
  type CardanoAddressBook,
  type CardanoBookAddress,
  type CardanoGovKeys,
  deriveCardanoAccountXpub,
  deriveCardanoAddress,
  deriveCardanoAddressBook,
  deriveCardanoBookAddressFromXpub,
  deriveCardanoGovKeys,
  deriveCardanoGovKeysFromAccountXpub,
  deriveCardanoRewardAddress,
  deriveCardanoRewardAddressFromXpub,
  discoverUsedCardanoAddresses,
} from './account/derivation/cardano.js'
export {deriveEvmAddress, deriveEvmAddressFromMnemonic} from './account/derivation/evm.js'
export {
  deriveMidnightNightAddress,
  deriveMidnightReceiveAddresses,
  deriveMidnightReceiveAddressesFromMnemonic,
  deriveMidnightRoleKey,
  type MidnightDeriveOptions,
  type MidnightNetworkId,
  type MidnightReceiveAddresses,
  setMidnightLedgerInitializer,
} from './account/derivation/midnight.js'
export {
  decodeDustAddressPayload,
  encodeDustAddress,
  encodeDustAddressPayload,
  encodeNightAddress,
  encodeShieldedAddress,
  encodeShieldedCoinPublicKey,
  encodeShieldedEncryptionPublicKey,
  type MidnightAddressKind,
  type MidnightAddressParse,
  nightPayloadFromVerifyingKey,
  parseMidnightAddress,
} from './account/derivation/midnight-address-encoding.js'
export {deriveSolanaAddress, deriveSolanaAddressFromMnemonic} from './account/derivation/solana.js'
export {type ChainFamily, getChainFamily, getDerivationConfig, getDerivationPath} from './account/derivation-config.js'
export {
  type AccountXpubLookup,
  DERIVE_ONLY_CHAIN_IDS,
  DERIVE_ONLY_CHAINS,
  DERIVE_ONLY_PERSISTED_CHAINS,
  DERIVE_ONLY_XPUB_CHAINS,
  type DeriveOnlyAddresses,
  type DeriveOnlyAddressStore,
  type DeriveOnlyChain,
  deriveAllFromSeed,
  getStoredDeriveOnlyAddresses,
  persistDeriveOnlyAddresses,
  persistDeviceDeriveOnlyAddress,
  type ResolvedDeriveOnlyAddresses,
  resolveDeriveOnlyAddresses,
} from './account/derive-only-addresses.js'
export {
  getStoredMidnightReceiveAddress,
  MIDNIGHT_RECEIVE_ADDRESS_SLOTS,
  type MidnightAddressStore,
  midnightNetworkIdForNetwork,
  midnightReceiveAddressRows,
  persistMidnightReceiveAddresses,
} from './account/midnight-receive-addresses.js'
// Midnight derivation (seed-based; see account/derivation/midnight.ts)
export {mnemonicToSeed} from './account/seed.js'
export {
  createWalletManager,
  deriveAccountXPub,
  generateGroupId,
  type WalletManagerConfig,
  WalletManagerLayer,
} from './account/wallet-manager.js'
export {createXPubStore, type XPubKey, type XPubStore} from './account/xpub-store.js'
// Errors
export {
  AccountNotFoundError,
  AddressDiscoveryError,
  DerivationError,
  InsufficientFundsError,
  InvalidMnemonicError,
  KeyMaterialUnavailableError,
  ProviderError,
  ProviderNetworkError,
  ProviderNotFoundError,
  SigningError,
  StorageError,
  SyncError,
  TransactionParseError,
  VerificationError,
  WalletCreationError,
  WalletError,
  WalletNotFoundError,
} from './errors.js'
// Store
export {
  createWalletDataStore,
  createWalletDataStoreEffect,
  type StoredBalance,
  type StoredBalances,
  type StoredTransaction,
  type StoredTxIO,
  type StoredUtxo,
  type TxBatchCursor,
  type TxCheckpoint,
  WALLET_SNAPSHOT_VERSION,
  type WalletDataStore,
  WalletDataStoreService,
  type WalletSnapshot,
} from './store/wallet-data-store.js'
export {type BackoffState, calculateBackoff, createBackoffState} from './sync/backoff.js'
// Sync
export {
  type ChainSyncer,
  type ChainSyncScheduler,
  type ChainSyncSchedulerConfig,
  type ChainSyncState,
  type ChainWalletKey,
  createChainSyncScheduler,
  type TxConfirmationChecker,
} from './sync/chain-sync-scheduler.js'
export {createSyncManager, SyncManagerLayer} from './sync/sync-manager.js'
export {parallelSync, prioritizeWallets, type SyncStrategy} from './sync/sync-strategies.js'
// Transaction
export {applyFilter, buildFilterPredicate, getTypeLabel} from './transaction/filter-pipeline.js'
export {type InMemoryAdapterControl, makeInMemoryAdapter} from './transaction/in-memory-adapter.js'
export {
  addOptimisticTransaction,
  confirmOptimisticTransaction,
  createOptimisticState,
  type OptimisticState,
  removeOptimisticTransaction,
} from './transaction/optimistic.js'
export {
  type ChainResult,
  type TransactionAdapter,
  TransactionHistory,
  type TransactionHistoryConfig,
  TransactionHistoryError,
  TransactionHistoryLive,
} from './transaction/transaction-history.js'
export {transactionInvolvesNft} from './transaction/transaction-involves-nft.js'
export {classifyTransaction, createTransactionSummary} from './transaction/transaction-summary.js'
export {
  txListItemsToTransactionData,
  txListItemToTransactionData,
} from './transaction/tx-list-item-to-transaction-data.js'
export type {
  NftTransfer,
  RichTokenTransfer,
  SwapAssetInfo,
  TokenTransfer,
  TransactionData,
  TransactionFilter,
  TransactionHistoryFilter,
  TransactionHistoryPagination,
  TransactionHistoryResponse,
  TransactionType,
} from './transaction/unified-transaction.js'
export {PRIMARY_TOKEN_ID, TransactionTypes} from './transaction/unified-transaction.js'
// Types
export type {
  Account,
  AccountEntry,
  AccountId,
  Address as WalletAddress,
  AddressChain,
  CacheAccountXPubParams,
  ChainConfig,
  ChainWallet,
  CreateFromDeviceParams,
  CreateFromMnemonicParams,
  CreateFromXPubParams,
  CreateReadOnlyParams,
  DerivativeInfo,
  HardwareDeviceType,
  Network,
  Pagination,
  SyncConfig,
  SyncState,
  TransactionDirection,
  TransactionStatus,
  TransactionSummary,
  TxFetchMode,
  UtxoManager as UtxoManagerService,
  WalletBalance,
  WalletBalanceEntry,
  WalletChecksum,
  WalletGroup,
  WalletGroupId,
  WalletImplementation,
  WalletManager as WalletManagerService,
  WalletProfile,
  WalletRef,
  WalletSelection,
  WalletSource,
  WalletSyncState,
  WalletTransaction,
  WalletTransactionInput,
  WalletTransactionOutput,
} from './types.js'
export {SyncManager, TX_FETCH_MODE, toChainWallet, UtxoManager, WalletManager} from './types.js'
// UTXO
export {
  createPendingTxTracker,
  DEFAULT_PENDING_TIMEOUT_MS,
  isPendingTxExpired,
  type PendingTx,
  type PendingTxPersistence,
  type PendingTxTracker,
  type PersistedPendingTx,
} from './utxo/pending-tx.js'
export {
  type CascadeSpec,
  cascadeRemove,
  lockedUtxoIdsOf,
  projectSpendable,
  type UtxoOverlayEntry,
  unconsumedChangeOf,
} from './utxo/spendable-projection.js'
export {utxoId} from './utxo/utxo.js'
export {createUtxoManager, UtxoManagerLayer} from './utxo/utxo-manager.js'
