/**
 * Wallet provider.
 *
 * Provides wallet state management via Effect services.
 * Gets network setting from ConfigProvider (global setting, not per-wallet).
 * Supports multi-chain wallets with per-chain balances and addresses.
 *
 * Performance optimizations:
 * - Split into multiple focused contexts to prevent cascading re-renders
 * - Granular state updates only when specific data changes
 * - Stable callback references using refs
 *
 * @module
 */

import {Assets as EvAssets, Address as EvolutionAddress, TransactionHash, UTxO} from '@evolution-sdk/evolution'
import type {Address as CardanoAddress} from '@pnyx/cardano-core'
import {CARDANO_MAINNET, type ChainId} from '@pnyx/config'
import type {AddressRow} from '@pnyx/store/address-table'
import type {AssetRow} from '@pnyx/store/assets-table'
import type {TxListItem} from '@pnyx/store/tx-table'
import type {UtxoRow} from '@pnyx/store/utxo-table'
import {
  type Account,
  type ChainSyncScheduler,
  type ChainSyncState,
  type ChainWallet,
  type ChainWalletKey,
  createChainSyncScheduler,
  type DeriveOnlyAddresses,
  type DeriveOnlyChain,
  type StoredTransaction,
  type StoredUtxo,
  type WalletGroup as StoredWalletGroup,
  TX_FETCH_MODE,
  type TxConfirmationChecker,
  type TxFetchMode,
  toChainWallet,
  type WalletBalance,
  WalletError,
  type WalletGroupId,
  type WalletProfile,
  type WalletSelection,
  type WalletSnapshot,
} from '@pnyx/wallet'
import {Effect, Fiber, Ref, Stream, SubscriptionRef} from 'effect'
import {createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react'
import {InteractionManager} from 'react-native'
import {startFanout} from '../dev/perf-tracers'
import {subscribeToRef} from '../hooks/service-state-subscription'
import {useLatestRef} from '../hooks/useLatestRef'
import {useServiceState} from '../hooks/useServiceState'
import {useWalletSelection} from '../hooks/useWalletSelection'
import {logger} from '../logger'
import {watchdog} from '../logger/watchdog'
import {isCardanoChainId} from '../services/cardano/chain-id'
import type {CardanoDiscoveryOptions, CardanoUsageProbe} from '../services/cardano/discovery'
import {persistCardanoGovKeys} from '../services/cardano/gov-keys'
import {cardanoRailSyncIsSupported, syncCardanoRail} from '../services/cardano/sync-rail'
import {FUNDS_CHAINS} from '../services/chains'
import {retrieveGroupMnemonicForChainEnable} from '../services/group-seed'
import {deleteDustKeyBook, forgetDustKeyForAccount, forgetDustKeysForGroup} from '../services/midnight/dust-key-book'
import {midnightFundsNetwork} from '../services/midnight/networks'
import {isMidnightChainId, syncMidnightUnshielded, syncScheduledDust} from '../services/midnight/scheduled-sync'
import {syncKeyAtCreate} from '../services/midnight/sync-key-at-create'
import {rememberSyncKeysForScheduler} from '../services/midnight/sync-keys'
import {forgetAllSyncKeys} from '../services/midnight/sync-keys-store'
import {
  dueForBackgroundSync,
  enabledAccountsOn,
  freshnessKey,
  syncFreshness,
} from '../services/midnight/wallet/sync-freshness'
import {
  createWalletService,
  type SnapshotKey,
  snapshotKey,
  type WalletService,
  type WalletServiceState,
} from '../services/wallet-service'
import {useConfig} from './ConfigProvider'
import {type DerivedGroupAddresses, mergeChainAddress} from './derived-group-addresses'
import {useI18n} from './I18nProvider'
import {ensureReceiveAddressValue} from './receive-address-guard'
import {reconcileRefreshedSyncStates} from './sync-state-reconcile'

/**
 * Staking info for display (runtime version with bigints).
 */
export type StakingInfo = {
  readonly registered: boolean
  readonly delegating: boolean
  readonly rewards: bigint
  readonly staked: bigint
  readonly poolId: string | null
  readonly poolTicker: string | null
  readonly poolName: string | null
  readonly stakeAddress: string
}

/**
 * Derive StakingInfo from a WalletSnapshot.
 */
const snapshotToStakingInfo = (snapshot: WalletSnapshot | undefined): StakingInfo | null => {
  if (!snapshot?.powers?.staking) return null
  const primary = BigInt(snapshot.balances.primary.quantity || '0')
  const rewards = BigInt(snapshot.balances.rewards?.available?.quantity || '0')
  return {
    registered: Boolean(snapshot.registered?.staking?.txHash),
    delegating: Boolean(snapshot.delegated?.staking?.txHash),
    rewards,
    // Cardano controlled stake = UTXO ADA + reward account balance. Rewards
    // count toward delegation weight until withdrawn.
    staked: primary + rewards,
    poolId: snapshot.delegated?.staking?.poolHash ?? null,
    poolTicker: null,
    poolName: null,
    stakeAddress: snapshot.powers.staking.human,
  }
}

/**
 * Derive WalletBalance from a WalletSnapshot.
 */
const snapshotToBalance = (snapshot: WalletSnapshot): WalletBalance => ({
  primary: {id: '.', quantity: BigInt(snapshot.balances.primary.quantity || '0')},
  secondary: snapshot.balances.secondary.map((e) => ({id: e.id, quantity: BigInt(e.quantity || '0')})),
})

/**
 * A persisted row to the in-memory UTxO.
 *
 * ⚠️ **It throws on a row it cannot read, and that replaced an empty-string address.** The old
 * shape took `stored.address ?? ''` — a bech32 that decodes to nothing, carried as if it were an
 * address, which is exactly what the Fallback Value Policy forbids. Evolution's `UTxO` validates
 * its address on construction, so a row either becomes a UTxO or fails loudly; `StoredUtxo.address`
 * is non-optional, so the fallback was unreachable as well as wrong.
 *
 * ⚠️ This file also used to declare its **own** `UTxO.UTxO` — a structural subset of
 * `@pnyx/wallet`'s, exported under the same name and re-exported from `providers/index.ts`, so a
 * consumer got one or the other depending on where it imported from. Both are gone.
 */
export const storedToUtxo = (stored: StoredUtxo): UTxO.UTxO =>
  new UTxO.UTxO({
    transactionId: TransactionHash.fromHex(stored.txHash),
    index: BigInt(stored.txIndex),
    address: EvolutionAddress.fromBech32(stored.address),
    assets: stored.assets.reduce(
      (bag, a) => {
        const [policy = '', name = ''] = a.id.split('.')
        return EvAssets.addByHex(bag, policy, name, BigInt(a.quantity))
      },
      EvAssets.fromLovelace(BigInt(stored.quantity)),
    ),
  })

/**
 * Parameters for creating a new wallet.
 * Note: Network is a global app setting, not per-wallet.
 */
/** Params for importing a hardware-device wallet group (no mnemonic). */
export type CreateFromDeviceContextParams = {
  readonly name: string
  readonly deviceType: import('@pnyx/wallet').HardwareDeviceType
  /** Account xpubs from the device, each naming the device account index it was derived at. */
  readonly publicKeys: readonly {
    readonly publicKey: Uint8Array
    readonly chainCode: Uint8Array
    readonly accountIndex: number
  }[]
  readonly chainId?: ChainId
  /** Link to an existing device group; auto-generated if omitted. */
  readonly groupId?: string
}

export type CreateWalletParams = {
  readonly name: string
  readonly mnemonic: string
  readonly chainId?: ChainId
  /** Group ID to link wallets from the same mnemonic (auto-generated if omitted). */
  readonly groupId?: string
  /** How the wallet was originally created (defaults to 'mnemonic'). */
  readonly source?: import('@pnyx/wallet').WalletSource
}

// ============================================================================
// Split Contexts for Performance
// ============================================================================

/**
 * Core wallet state (loading, ready, errors).
 */
export type WalletCoreContextValue = {
  readonly isReady: boolean
  readonly isLoading: boolean
  readonly error: string | null
  readonly clearError: () => void
}

/**
 * A wallet group for UI display — derived from the stored WalletGroup.
 * Represents one seed phrase / hardware device.
 * All chain-specific ChainWallet entries are bundled here.
 */
export type WalletGroupView = {
  readonly groupId: string
  readonly name: string
  readonly chains: readonly ChainId[]
  readonly primaryWallet: ChainWallet
  readonly wallets: readonly ChainWallet[]
  readonly profile?: WalletProfile
}

/** @deprecated Use WalletGroupView instead */
export type WalletGroup = WalletGroupView

/**
 * Wallet list management (wallets, selection, CRUD).
 */
export type WalletListContextValue = {
  /** Wallets belonging to the selected wallet group. */
  readonly wallets: readonly ChainWallet[]
  /** All wallets across every group — use for global operations like full reset or cross-group lookups. */
  readonly allWallets: readonly ChainWallet[]
  readonly walletGroups: readonly WalletGroup[]
  readonly selectedWalletGroup: WalletGroup | null
  readonly accounts: readonly Account[]
  readonly selectedAccountIndex: number
  readonly accountCount: number
  /** Selects a wallet group. Pass null to deselect. Chain is per-screen, never global. */
  readonly selectWallet: (groupId: string | null) => Promise<void>
  /** Deselects to show the "All Blockchains" aggregate view. */
  readonly selectAllBlockchains: () => Promise<void>
  readonly selectAccount: (chainId: ChainId, index: number) => Promise<void>
  readonly addAccount: (chainId: ChainId) => Promise<void>
  readonly createWallet: (params: CreateWalletParams) => Promise<ChainWallet>
  readonly restoreWallet: (params: CreateWalletParams) => Promise<ChainWallet>
  /** Import a hardware-device wallet group from pre-derived account xpubs. Returns the new groupId. */
  readonly createFromDevice: (params: CreateFromDeviceContextParams) => Promise<string>
  /** Persist a device-derived derive-only address (Solana) that can't be rebuilt from an xpub. */
  readonly persistDeviceDeriveOnlyAddress: (params: {
    readonly groupId: string
    readonly chain: DeriveOnlyChain
    readonly accountIndex: number
    readonly address: string
  }) => Promise<void>
  /** Store hardware-device xpubs for derive-only chains (BTC/EVM) at `accountIndex` so the address rebuilds on read. */
  readonly setDeviceXpubs: (
    groupId: string,
    entries: readonly {publicKey: Uint8Array; chainCode: Uint8Array; chainId: ChainId}[],
    accountIndex?: number,
  ) => Promise<void>
  /** Add a device-derived account at `accountIndex` to an existing hardware group (xpub + register/enable). */
  readonly addDeviceAccount: (
    groupId: string,
    chainId: ChainId,
    accountIndex: number,
    key: {publicKey: Uint8Array; chainCode: Uint8Array},
  ) => Promise<void>
  /** Add a read-only ("watch-only") Cardano wallet from a resolved base-address set. Returns the new groupId. */
  readonly createReadOnlyWallet: (params: {
    name: string
    addresses: readonly string[]
    checksumSeed?: string
  }) => Promise<string>
  /**
   * Register a CIP-1854 shared wallet as a group, so it appears in the wallet
   * list and every ordinary flow can select it. Idempotent on `groupId`.
   */
  readonly registerSharedWalletGroup: (params: {
    groupId: string
    name: string
    addresses: readonly string[]
    checksumSeed?: string
  }) => Promise<string>
  readonly deleteWallet: (groupId: string) => Promise<void>
  /** Delete all wallet groups and their mnemonics. Throws on failure (no error swallowing). Used by reset flows. */
  readonly deleteAllWalletData: () => Promise<void>
  readonly renameWallet: (groupId: string, name: string) => Promise<void>
  readonly cacheAccountXPub: (params: {
    groupId: string
    chainId: ChainId
    publicKey: Uint8Array
    chainCode: Uint8Array
    accountIndex?: number
  }) => Promise<void>
  /** Enable a new chain for an existing wallet group (creates the chain wallet). */
  readonly enableChainForGroup: (groupId: string, chainId: ChainId) => Promise<ChainWallet | undefined>
  /** Disable a chain for a wallet group (deletes the chain wallet). */
  readonly disableChainForGroup: (groupId: string, chainId: ChainId) => Promise<void>
  /** Store pre-derived xpubs (from hardware) and populate accounts array. */
  readonly scanAccountsFromXPubs: (
    groupId: string,
    chainId: ChainId,
    xpubs: ReadonlyArray<{readonly index: number; readonly xpub: Uint8Array}>,
  ) => Promise<ChainWallet>
  /** Enable a discovered account so it syncs. */
  readonly enableAccount: (groupId: string, chainId: ChainId, accountIndex: number) => Promise<ChainWallet>
  /** Disable an account (stops syncing). Cannot disable account 0. */
  readonly disableAccount: (groupId: string, chainId: ChainId, accountIndex: number) => Promise<ChainWallet>
}

/**
 * Balance data.
 */
export type WalletBalanceContextValue = {
  readonly balance: WalletBalance | null
  readonly balancesByChain: ReadonlyMap<ChainId, WalletBalance>
  readonly getBalanceForChain: (chainId: ChainId) => WalletBalance | null
  readonly refreshBalance: () => Promise<void>
}

/**
 * Sync state and operations.
 */
export type WalletSyncContextValue = {
  /** True when any chain is currently syncing. Derived from per-chain states. */
  readonly isSyncing: boolean
  /** Per-chain sync state — use this for granular reactions to individual chain completions. */
  readonly chainSyncStates: ReadonlyMap<string, import('@pnyx/wallet').ChainSyncState>
  readonly syncWallet: () => Promise<void>
  /** Sync a specific chain wallet — works even when no wallet is selected in the UI. */
  readonly syncWalletById: (groupId: string, chainId: ChainId, options?: {txMode?: TxFetchMode}) => Promise<void>
  readonly syncChain: (chainId: ChainId) => Promise<void>
  /** Boost a chain's sync schedule after tx submission (10s polling until tx confirmed or 2min timeout). */
  readonly boostChainSync: (groupId: string, chainId: ChainId, txHash?: string) => void
}

/**
 * Address management.
 */
export type IndexedAddress = {readonly address: string; readonly index: number}

export type WalletAddressContextValue = {
  readonly receiveAddresses: ReadonlyMap<ChainId, string>
  readonly getReceiveAddress: (params?: {
    readonly groupId?: string
    readonly chainId?: ChainId
    readonly accountIndex?: number
    readonly addressIndex?: number
  }) => Promise<string>
  /** Stored derive-only companion addresses for the selected group + account (default 0), persisted at create/restore; `{}` if none. */
  readonly getDeriveOnlyAddresses: (accountIndex?: number) => Promise<Partial<DeriveOnlyAddresses>>
  /**
   * The same, for a wallet that is **not** the selected one.
   *
   * ⚠️ Its own accessor rather than a parameter on the one above, so no existing caller silently changes
   * meaning. The service has always taken a group id; only the wrapper substituted the active group —
   * which is why an agent granted several wallets could not read any but the selected one.
   */
  readonly getDeriveOnlyAddressesFor: (groupId: string, accountIndex: number) => Promise<Partial<DeriveOnlyAddresses>>
  /**
   * Write any Midnight receive addresses a group is missing, for every network.
   *
   * Repairs wallets created before those rows were network-keyed. Needs the
   * mnemonic, so callers pass one they already hold — it must not prompt on its
   * own. Returns the networks written; `[]` means the set was already complete.
   */
  readonly ensureMidnightReceiveAddresses: (params: {
    readonly groupId: string
    readonly mnemonic: string
    readonly accountIndex?: number
  }) => Promise<readonly string[]>
  /**
   * Seedless Cardano address discovery for the selected group + account — derives
   * the book from the stored xpub, gap-limit scans via `probe`, persists the rows,
   * and returns the addresses the rail should sync (used + primary). `[]` when
   * no group is selected or the xpub is not yet persisted.
   */
  readonly discoverCardanoAddresses: (
    network: CardanoAddress.Network,
    probe: CardanoUsageProbe,
    accountIndex?: number,
    options?: CardanoDiscoveryOptions,
  ) => Promise<readonly string[]>
  readonly getChangeAddress: (params?: {
    readonly groupId?: string
    readonly chainId?: ChainId
    readonly accountIndex?: number
  }) => Promise<string>
  readonly getStakeAddress: () => Promise<string>
  readonly getUsedAddresses: () => Promise<readonly string[]>
  readonly getUnusedAddresses: () => Promise<readonly string[]>
  readonly getUsedAddressesIndexed: () => Promise<readonly IndexedAddress[]>
  readonly getUnusedAddressesIndexed: () => Promise<readonly IndexedAddress[]>
  readonly getInternalAddressesIndexed: () => Promise<readonly IndexedAddress[]>
}

/**
 * Additional wallet data (staking, UTxOs, transactions).
 */
export type WalletDataContextValue = {
  readonly stakingInfo: StakingInfo | null
  readonly getUtxos: (params?: {
    readonly groupId?: string
    readonly chainId?: ChainId
    readonly accountIndex?: number
  }) => Promise<readonly UTxO.UTxO[]>
  // `decryptMnemonicForWallet` deliberately does NOT belong here. A
  // plaintext-mnemonic getter on this context is reachable from every
  // `useWalletData()` consumer and shows up in autocomplete next to ordinary
  // wallet state, which is how a screen ends up holding seed material it never
  // needed (Phase 16 item 42). It stays a local function for this provider's own
  // `enableChain` slow path. Callers that genuinely need seed-derived work ask
  // for the derived result: signing goes through `CredentialStoreDeps
  // .retrieveMnemonic` as a lazy callback.
  readonly getAccountXPub: (chainId?: ChainId, groupId?: string, accountIndex?: number) => Promise<Uint8Array>
  readonly getSnapshotForWallet: (
    groupId: string,
    chainId: ChainId,
    accountIndex?: number,
  ) => Promise<WalletSnapshot | null>
  readonly getTransactionForWallet: (
    groupId: string,
    chainId: ChainId,
    txHash: string,
  ) => Promise<StoredTransaction | null>
  /**
   * Indexed list of transaction rows for the activity view — projection only.
   *
   * Skips the `detailJson` blob and the per-row JSON.parse that the legacy
   * `getTransactionsForWallet` path had. Pair with `getTransactionForWallet`
   * (returns a full {@link StoredTransaction}) when the detail screen opens.
   */
  readonly listTransactionRowsForWallet: (
    groupId: string,
    chainId: ChainId,
    accountIndex: number,
    query?: {readonly limit?: number; readonly offset?: number; readonly olderThan?: number},
  ) => Promise<readonly TxListItem[]>
  /**
   * Global token-metadata cache (shared across wallets). `getTokenMetadata`
   * returns cached metadata for the given token ids on the current network;
   * `saveTokenMetadata` upserts freshly-fetched metadata. Backs the portfolio
   * enrichment so a refresh only fetches metadata for tokens not already cached.
   */
  readonly getTokenMetadata: (
    tokenIds: readonly string[],
  ) => Promise<ReadonlyMap<string, {data: unknown; fetchedAt: number}>>
  readonly saveTokenMetadata: (entries: readonly {tokenId: string; data: unknown}[], now: number) => Promise<void>
  /**
   * Persisted portfolio-assets cache (Cardano). `listAssetsForWallet` reads the
   * partition sorted by usd_value desc (cache-first paint); `saveAssetsForWallet`
   * atomically replaces it after a fresh balance+price enrichment.
   */
  readonly listAssetsForWallet: (groupId: string, accountIndex: number) => Promise<readonly AssetRow[]>
  readonly saveAssetsForWallet: (groupId: string, accountIndex: number, rows: readonly AssetRow[]) => Promise<void>
  /**
   * Indexed list of UTXO rows for a chain wallet.
   *
   * Replaces direct `snapshot.utxos` reads. Use `pureOnly: true` to filter
   * to UTXOs with no native-token bundle (Plutus collateral candidates).
   */
  readonly listUtxosForWallet: (
    groupId: string,
    chainId: ChainId,
    options?: {readonly accountIndex?: number; readonly pureOnly?: boolean},
  ) => Promise<readonly UtxoRow[]>
  /**
   * Indexed list of derived address rows for a chain wallet.
   *
   * Replaces direct `snapshot.addresses` reads. Filter by `branch` to scope
   * to receive (`external`), change (`internal`), or single-address chains
   * (`single`). `isUsed` filters to addresses observed on-chain.
   */
  readonly listAddressesForWallet: (
    groupId: string,
    chainId: ChainId,
    options?: {
      readonly accountIndex?: number
      readonly branch?: 'external' | 'internal' | 'single'
      readonly isUsed?: boolean
    },
  ) => Promise<readonly AddressRow[]>
  /**
   * Cross-wallet address scan for a chain — returns every derived row
   * for the given chain across every wallet group. Backed by the
   * AddressTable's `(chainId, isUsed)` index, so this is a single
   * SQL/IndexedDB read regardless of group count.
   */
  readonly listAddressesForChain: (chainId: ChainId) => Promise<readonly AddressRow[]>
}

// Create the split contexts
export const WalletCoreContext = createContext<WalletCoreContextValue | null>(null)
export const WalletListContext = createContext<WalletListContextValue | null>(null)
export const WalletBalanceContext = createContext<WalletBalanceContextValue | null>(null)
export const WalletSyncContext = createContext<WalletSyncContextValue | null>(null)
export const WalletAddressContext = createContext<WalletAddressContextValue | null>(null)
export const WalletDataContext = createContext<WalletDataContextValue | null>(null)

export type WalletProviderProps = {
  children: ReactNode
}

// ============================================================================
// Utility functions
// ============================================================================

/**
 * Derive all ChainWallet entries from a groups map.
 */
function deriveAllWalletMetas(groups: ReadonlyMap<WalletGroupId, StoredWalletGroup>): ChainWallet[] {
  const metas: ChainWallet[] = []
  for (const group of groups.values()) {
    for (const chainId of group.chains.keys()) {
      const meta = toChainWallet(group, chainId)
      if (meta) metas.push(meta)
    }
  }
  return metas
}

/**
 * Build a lightweight fingerprint of the snapshot fields consumed by the UI.
 * When this string is identical between two snapshots, the derived React state
 * (balance, staking info, addresses) is guaranteed to be the same.
 */
function snapshotFingerprint(s: WalletSnapshot): string {
  const secondary = s.balances.secondary.map((e) => `${e.id}:${e.quantity}`).join(',')
  const rewardsQty = s.balances.rewards?.available?.quantity ?? '0'
  const delegated = s.delegated?.staking?.poolHash ?? ''
  const registered = s.registered?.staking?.txHash ?? ''
  const txCount = s.txCount ?? 0
  // Addresses live in the AddressTable and aren't on the snapshot — every
  // `isUsed` flip is paired with a `txCount` change by chain-sync, so the
  // fingerprint still captures address-set churn indirectly.
  return `${s.chainId}|${s.balances.primary.quantity}|${secondary}|${rewardsQty}|${delegated}|${registered}|${txCount}`
}

// Fingerprint cache — by snapshot identity. WalletSnapshot objects are
// immutable from this provider's perspective (the service hands out a new
// object on every change), so a WeakMap keyed by object identity is safe
// and frees entries automatically when old snapshots are GC'd. Saves the
// ~200-char string build per snapshot per comparison.
const snapshotFingerprintCache = new WeakMap<WalletSnapshot, string>()
const cachedFingerprint = (s: WalletSnapshot): string => {
  const cached = snapshotFingerprintCache.get(s)
  if (cached !== undefined) return cached
  const fp = snapshotFingerprint(s)
  snapshotFingerprintCache.set(s, fp)
  return fp
}

/**
 * Compare two snapshot Maps by their UI-visible data rather than object identity.
 * This avoids re-renders when sync creates new snapshot objects with identical data,
 * while still detecting changes to any balance, token, staking, or address field.
 *
 * Object-identity fast-path first — if both sides point at the same
 * WalletSnapshot instance, skip fingerprinting entirely.
 */
function snapshotsChanged(
  a: ReadonlyMap<SnapshotKey, WalletSnapshot>,
  b: ReadonlyMap<SnapshotKey, WalletSnapshot>,
): boolean {
  if (a.size !== b.size) return true
  for (const [key, snapA] of a) {
    const snapB = b.get(key)
    if (!snapB) return true
    if (snapA === snapB) continue
    if (cachedFingerprint(snapA) !== cachedFingerprint(snapB)) return true
  }
  return false
}

/** Stable identity so an absent service does not hand React a new empty map each render. */
const EMPTY_GROUPS: ReadonlyMap<WalletGroupId, StoredWalletGroup> = new Map()

const selectGroups = (state: WalletServiceState): ReadonlyMap<WalletGroupId, StoredWalletGroup> => state.groups

// ============================================================================
// Provider Implementation
// ============================================================================

/**
 * Wallet provider with Effect service integration.
 * Gets network from ConfigProvider (global setting).
 *
 * Uses split contexts for performance - components only re-render when their
 * specific data changes.
 *
 * @example
 * ```tsx
 * <ConfigProvider>
 *   <WalletProvider>
 *     <App />
 *   </WalletProvider>
 * </ConfigProvider>
 * ```
 */
export function WalletProvider({children}: WalletProviderProps) {
  const {network, isNetworkLoading} = useConfig()
  const {t} = useI18n()
  const biometricAuthPromptRef = useLatestRef(t('common.biometricPrompt'))
  // MigrationProvider's blob-coupling has been retired — the silent
  // first-launch flow extracts and materialises in one step (see
  // `useSilentMaterialisation`), so per-wallet create paths no longer need
  // to reach into the in-flight migration blob.

  // ============================================================================
  // Granular State (split for selective updates)
  // ============================================================================

  // Core state
  const [isReady, setIsReady] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Wallet group state — read straight off the service's state, which is the source of truth. The ref
  // lives in `useState` and not a `useRef` because the service is built asynchronously: filling a ref
  // does not re-render, so the first read would be `undefined` for ever.
  const [walletStateRef, setWalletStateRef] = useState<SubscriptionRef.SubscriptionRef<WalletServiceState> | undefined>(
    undefined,
  )
  const groups = useServiceState(walletStateRef, selectGroups) ?? EMPTY_GROUPS
  const [selection, setSelection] = useState<WalletSelection | null>(null)

  // Snapshot state — single source of truth for wallet data
  const [snapshots, setSnapshots] = useState<ReadonlyMap<SnapshotKey, WalletSnapshot>>(new Map())

  // XPub-derived addresses for group wallets that have no cached snapshot yet.
  // Keyed by groupId so receiveAddresses can reject stale entries without
  // depending on effects firing at exactly the right time.
  const [derivedGroupAddresses, setDerivedGroupAddresses] = useState<DerivedGroupAddresses>({
    groupId: null,
    addresses: new Map(),
  })

  // Sync state — derived from per-chain scheduler states
  const [chainSyncStates, setChainSyncStates] = useState<ReadonlyMap<ChainWalletKey, ChainSyncState>>(new Map())
  const isSyncing = useMemo(() => [...chainSyncStates.values()].some((s) => s.status === 'syncing'), [chainSyncStates])
  const schedulerRef = useRef<ChainSyncScheduler | null>(null)

  // ============================================================================
  // Refs (for stable callbacks and tracking previous state)
  // ============================================================================

  const walletServiceRef = useRef<WalletService | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const selectionRef = useRef<WalletSelection | null>(null)

  // Dedup guard for syncWalletById — prevents concurrent syncs for the same key.
  const activeSyncsRef = useRef<Map<string, Promise<void>>>(new Map())

  // Track previous state for selective updates
  const prevStateRef = useRef<WalletServiceState | null>(null)

  const groupsRef = useLatestRef(groups)
  selectionRef.current = selection

  // Tracks the resolved wallet group across both aggregate ("All Blockchains")
  // and single-chain views so callbacks like syncWallet always have a group.
  const activeGroupRef = useRef<WalletGroupView | null>(null)

  // ============================================================================
  // Derived State
  // ============================================================================

  // Derive flat ChainWallet array from groups for backward compat
  const walletsArray = useMemo(() => deriveAllWalletMetas(groups), [groups])

  const walletGroups = useMemo((): WalletGroup[] => {
    const result: WalletGroup[] = []
    for (const group of groups.values()) {
      const metas: ChainWallet[] = []
      const chainIds: ChainId[] = []
      for (const chainId of group.chains.keys()) {
        chainIds.push(chainId)
        const meta = toChainWallet(group, chainId)
        if (meta) metas.push(meta)
      }
      if (metas.length === 0) continue
      // metas.length > 0 is guaranteed by the continue above
      const primaryWallet = metas.find((w) => w.chainId === CARDANO_MAINNET) ?? (metas[0] as ChainWallet)
      result.push({
        groupId: group.groupId,
        name: group.name,
        chains: chainIds,
        primaryWallet,
        wallets: metas,
        ...(group.profile ? {profile: group.profile} : {}),
      })
    }
    return result
  }, [groups])

  const {selectWallet, selectAllBlockchains, lastGroupId} = useWalletSelection({
    clearSelection: () => setSelection(null),
    persistGroup: async (groupId) => {
      const service = walletServiceRef.current
      if (!service) return
      const prev = selectionRef.current
      selectingRef.current = true
      try {
        if (groupId) {
          // Persist group-level selection. accountIndex defaults to whatever
          // the previous selection had if same group, else 0.
          const accountIndex = prev?.groupId === groupId ? prev.accountIndex : 0
          const newSelection: WalletSelection = {groupId: groupId as WalletGroupId, accountIndex}
          setSelection(newSelection)
          await Effect.runPromise(service.select(newSelection))
        } else {
          await Effect.runPromise(service.deselect())
        }
        // Persist in both branches — `walletManager.save()` removes the
        // SELECTED_KEY storage entry when selection is null, so the "All
        // Blockchains" choice survives an app restart instead of being
        // re-loaded as the previous selection.
        await Effect.runPromise(service.save())
      } catch (e) {
        logger.error('Failed to persist wallet selection', {origin: 'WalletProvider', error: e})
        setSelection(prev)
      } finally {
        selectingRef.current = false
      }
    },
  })

  const selectedWalletGroup = useMemo(() => {
    // lastGroupId is updated synchronously when selectWallet is called (before
    // the async persistChain/setSelection completes). It therefore reflects the
    // target group immediately, whereas selection?.groupId only catches up
    // after the async service call settles. Prioritising lastGroupId prevents
    // the previous wallet's data from leaking during the transition window.
    const targetGroupId = lastGroupId ?? selection?.groupId ?? null
    if (targetGroupId) {
      return walletGroups.find((g) => g.groupId === targetGroupId) ?? walletGroups[0] ?? null
    }
    return walletGroups[0] ?? null
  }, [walletGroups, selection, lastGroupId])
  activeGroupRef.current = selectedWalletGroup

  // Exposed for the few screens that still show "which account" on top of the
  // primary chain. Falls back to 0 when no selection exists. `accountCount`
  // reports the primary (Cardano) chain's account count — multi-account is
  // meaningful per chain and we surface the Cardano one.
  const selectedAccountIndex = selection?.accountIndex ?? 0
  const accountCount = selectedWalletGroup?.primaryWallet.accounts.length ?? 1

  const groupWallets = useMemo(
    () => (selectedWalletGroup ? selectedWalletGroup.wallets : walletsArray),
    [selectedWalletGroup, walletsArray],
  )

  // Populate addresses for all chains in the selected group so receiveAddresses
  // is fully available for swap routing, not just the currently selected chain.
  //
  // Two-pronged approach:
  //   1. XPub derivation — derives the external 0/0 address offline from the
  //      account XPub and stores the result in derivedGroupAddresses. Pure
  //      compute, no network — runs IMMEDIATELY so feature screens (Send,
  //      Swap) can read sender addresses the moment they mount. A past bug was
  //      caused by deferring this behind InteractionManager and committing
  //      all addresses at once: on mobile, active touches/animations kept the
  //      callback pending, and the user reached Send before any address was
  //      derived.
  //   2. loadGroupSnapshots + syncChainWallet — disk reads and network fetches.
  //      Deferred behind InteractionManager because syncing 5+ chains
  //      synchronously produced a 7.1s passive-effect burst on mount.
  //
  // INVARIANT: This effect fires only on group SWITCH (groupId changes), NOT
  // when chains are added to the current group. Chain additions must sync
  // themselves — createWallet and enableChainForGroup both call syncChainWallet
  // AND derive+merge their own receive address (via setDerivedGroupAddresses +
  // mergeChainAddress) independently. Without the address-merge step,
  // receiveAddresses ends up missing every chain added after the initial
  // group-switch fan-out and TransferProvider throws "No sender address
  // available". Any new chain-add code path must do the same.
  // biome-ignore lint/correctness/useExhaustiveDependencies: depend on groupId string, not object ref — walletGroups rebuilds all group objects on any state change, giving selectedWalletGroup a new ref for the same groupId. Object ref dep caused spurious re-syncs (~56 extra requests).
  useEffect(() => {
    const service = walletServiceRef.current
    const group = selectedWalletGroup

    // selectedWallet is intentionally NOT used as a guard here: after a
    // select-group intent (e.g. just after onboarding / wallet restore),
    // selectedWallet is null while selectedWalletGroup already reflects the
    // new group (lastGroupId updated synchronously). We must still load
    // snapshots and derive addresses for the new group in that state.
    if (!service || !group) return

    let active = true
    const groupId = group.groupId

    // Reset derived addresses for the new group immediately so that any
    // in-flight results from the previous group are discarded on arrival.
    setDerivedGroupAddresses({groupId, addresses: new Map()})

    // Address derivation — pure offline xpub work. Commit each address as it
    // resolves (instead of awaiting Promise.all on every chain) so a single
    // slow derivation can't keep the whole map empty.
    const addrFanout = startFanout(
      'WalletProvider.getReceiveAddress',
      group.wallets.map((w) => `${w.groupId}:${w.chainId}`),
    )
    for (const w of group.wallets) {
      const label = `${w.groupId}:${w.chainId}`
      const chainId = w.chainId
      Effect.runPromise(service.getReceiveAddress({groupId: w.groupId as WalletGroupId, chainId}))
        .then((addr) => {
          addrFanout.itemOk(label)
          if (!active) return
          setDerivedGroupAddresses((prev) => mergeChainAddress(prev, groupId, chainId, addr))
        })
        .catch((e) => addrFanout.itemErr(label, e))
    }

    // Defer the network + disk work until after the current interaction
    // finishes. Observed per-group wall time from the 2026-04-18 capture:
    // 6–29 s for 5 chains, with the non-Cardano chains finishing within a
    // 30 ms window (the indexer backend / RN fetch pool serialises them
    // upstream — not fixable client-side cheaply). Running this
    // synchronously blocked the commit queue and produced a 7.1 s
    // passive-effect burst on mount.
    const interaction = InteractionManager.runAfterInteractions(() => {
      if (!active) return

      const syncFanout = startFanout(
        'WalletProvider.syncChainWallet',
        group.wallets.map((w) => `${w.groupId}:${w.chainId}`),
      )

      Effect.runPromise(service.loadGroupSnapshots(groupId as WalletGroupId)).catch((e) => {
        logger.warn('Failed to load group snapshots; screens paint from whatever is cached', {
          origin: 'WalletProvider',
          groupId,
          error: String(e),
        })
      })

      // Trigger a background sync for all chains in the selected group so
      // the UTxO snapshot is fresh when the user acts (e.g. signs a swap).
      // Without this, switching wallets would leave the snapshot at whatever
      // was last cached, causing "No signing keys found" if the UTxOs
      // changed since the last sync.
      for (const w of group.wallets) {
        const label = `${w.groupId}:${w.chainId}`
        Effect.runPromise(
          service.syncChainWallet(w.groupId as WalletGroupId, w.chainId, {txMode: TX_FETCH_MODE.RECENT}),
        )
          .then(() => syncFanout.itemOk(label))
          .catch((e) => {
            syncFanout.itemErr(label, e)
            logger.error('Failed to sync chain wallet after group switch', {
              origin: 'WalletProvider',
              groupId: w.groupId,
              chainId: w.chainId,
              error: e,
            })
          })
      }
    })

    return () => {
      active = false
      interaction.cancel()
    }
  }, [selectedWalletGroup?.groupId])

  // Derived snapshot key for the current selection. Pins chainId to Cardano:
  // the legacy `balance` / `stakingInfo` singleton API is Cardano-anchored
  // (used by useTokens for ADA native tokens, by useBalances for locked ADA,
  // by useStakingInfo for pool delegation). Chain-specific reads go through
  // `getBalanceForChain(chainId)` instead.
  const selectedSnapshotKey = useMemo<SnapshotKey | null>(() => {
    if (!selection) return null
    return snapshotKey(selection.groupId, CARDANO_MAINNET, selection.accountIndex)
  }, [selection])

  // Derived from snapshots
  const selectedSnapshot = useMemo(
    () => (selectedSnapshotKey ? (snapshots.get(selectedSnapshotKey) ?? undefined) : undefined),
    [snapshots, selectedSnapshotKey],
  )

  const balance = useMemo<WalletBalance | null>(
    () => (selectedSnapshot ? snapshotToBalance(selectedSnapshot) : null),
    [selectedSnapshot],
  )

  const balancesByChain = useMemo<ReadonlyMap<ChainId, WalletBalance>>(() => {
    const map = new Map<ChainId, WalletBalance>()
    if (!selectedWalletGroup) return map
    const groupId = selectedWalletGroup.groupId
    for (const [key, snapshot] of snapshots) {
      if (key.startsWith(`${groupId}:`)) {
        map.set(snapshot.chainId, snapshotToBalance(snapshot))
      }
    }
    return map
  }, [snapshots, selectedWalletGroup])

  const receiveAddresses = useMemo<ReadonlyMap<ChainId, string>>(() => {
    const map = new Map<ChainId, string>()
    const currentGroupId = selectedWalletGroup?.groupId ?? null

    // Offline-derived addresses (external 0/0) for every chain in the group.
    // Always matches what chain-sync writes to the AddressTable for index 0,
    // so we don't need a second snapshot-overlay pass anymore. The derived
    // state is tagged with the groupId it was computed for so that stale
    // values from a previous group never leak into receiveAddresses even
    // between renders (effects fire after the render, so a groupId guard
    // here is the only safe check).
    if (derivedGroupAddresses.groupId === currentGroupId && currentGroupId !== null) {
      for (const [chainId, addr] of derivedGroupAddresses.addresses) {
        map.set(chainId, addr)
      }
    }
    return map
  }, [derivedGroupAddresses, selectedWalletGroup])

  const stakingInfo = useMemo<StakingInfo | null>(() => snapshotToStakingInfo(selectedSnapshot), [selectedSnapshot])

  // ============================================================================
  // Selective State Update from Service
  // ============================================================================

  // Guard: when selectWallet sets selection eagerly, subscription callbacks from the
  // service (e.g. periodic sync) must not override it until the service call completes.
  const selectingRef = useRef(false)

  const updateFromServiceState = useCallback((state: WalletServiceState) => {
    const prev = prevStateRef.current

    if (!selectingRef.current && (!prev || state.selection !== prev.selection)) {
      setSelection(state.selection)
    }

    if (!prev || snapshotsChanged(state.snapshots, prev.snapshots)) {
      setSnapshots(state.snapshots)
    }

    // isSyncing is now derived from chainSyncStates — no longer read from service state

    if (state.lastError && (!prev || state.lastError !== prev.lastError)) {
      setError(state.lastError)
    }

    prevStateRef.current = state
  }, [])

  // ============================================================================
  // Checksum
  // ============================================================================

  /**
   * Compute and attach checksum + profile to a group if missing.
   * Delegates checksum derivation to the wallet-manager package, then
   * derives a deterministic profile from the checksum seed.
   */
  const attachChecksumAndProfile = useCallback(
    async (
      group: StoredWalletGroup,
      chainId: ChainId,
      iconStyle?: WalletProfile['iconStyle'],
      iconSeed?: string,
    ): Promise<ChainWallet> => {
      const meta = toChainWallet(group, chainId)
      if (!meta) throw new WalletError({message: `Chain ${chainId} not found in group`})
      if (group.checksum && group.profile) return meta

      const walletService = walletServiceRef.current
      if (!walletService) return meta

      try {
        const checksum =
          group.checksum ??
          (await Effect.runPromise(walletService.walletManager.attachChecksum(group.groupId as WalletGroupId)))
        if (!checksum) {
          logger.warn('No xpub available for checksum', {origin: 'WalletProvider', groupId: group.groupId})
          return meta
        }

        const profile: WalletProfile = {
          ...group.profile,
          ...(iconStyle ? {iconStyle} : {}),
          ...(iconSeed ? {iconSeed} : {}),
        }

        // Persist profile on the group
        if (!group.profile) {
          await Effect.runPromise(
            Ref.update(walletService.walletManager.groups, (map) => {
              const next = new Map(map)
              const existing = next.get(group.groupId)
              if (existing) next.set(group.groupId, {...existing, profile})
              return next
            }),
          )
        }

        await Effect.runPromise(walletService.save())
        return {...meta, checksum, profile}
      } catch (e) {
        logger.warn('Failed to compute wallet checksum', {origin: 'WalletProvider', groupId: group.groupId, cause: e})
        return meta
      }
    },
    [],
  )

  // Service Initialization
  useEffect(() => {
    if (isNetworkLoading) return

    let mounted = true

    const init = async () => {
      try {
        const allChains = FUNDS_CHAINS
        logger.info('Initializing wallet provider', {
          origin: 'WalletProvider',
          network,
          chainCount: allChains.length,
        })

        if (unsubscribeRef.current) {
          unsubscribeRef.current()
          unsubscribeRef.current = null
        }

        // Close the previous store to release database connections
        if (walletServiceRef.current) {
          await Effect.runPromise(walletServiceRef.current.close()).catch((e) =>
            logger.warn('Failed to close previous store', {origin: 'WalletProvider', error: e}),
          )
          walletServiceRef.current = null
          setWalletStateRef(undefined)
        }

        setIsReady(false)
        prevStateRef.current = null

        // Pass all supported chains to the provider registry — it's a backend concern.
        // The UI filters by enabledChains from ConfigProvider separately.
        const walletService = await Effect.runPromise(
          createWalletService({
            network,
            enabledChains: FUNDS_CHAINS,
          }),
        )
        if (!mounted) return

        walletServiceRef.current = walletService
        setWalletStateRef(walletService.state)

        // Load persisted state BEFORE subscribing so that subscription callbacks
        // triggered by load() don't race with our startup reset of selection.
        try {
          await Effect.runPromise(walletService.load())
        } catch (e) {
          // First-run (no saved data) produces a benign StorageError — only log unexpected errors
          const msg = e instanceof Error ? e.message : String(e)
          if (msg && !msg.includes('Failed to parse wallets') && !msg.includes('not found')) {
            logger.warn('Wallet load error (non-fatal)', {origin: 'WalletProvider', error: msg})
          }
        }

        const initialState = await Effect.runPromise(walletService.getState())
        if (mounted) {
          updateFromServiceState(initialState)

          // Restore persisted selection directly — no deselect/re-select dance.
          // The service already restored the selection from storage in load().
          // Just sync React state and lastGroupId with what was persisted.
          const restoredSelection = initialState.selection
          if (restoredSelection) {
            setSelection(restoredSelection)
          }

          setIsReady(true)
          logger.info('Wallet provider initialized', {
            origin: 'WalletProvider',
            walletGroupCount: initialState.groups.size,
            selectedGroupId: restoredSelection?.groupId ?? null,
            // ⚠️ `null` above is a real state — the "All Blockchains" choice removes the stored
            // selection on purpose — but `selectedWalletGroup` then falls back to the *first* group
            // in map order, and every consumer acts on it: the startup sync, the balance, the
            // header. The log said `selectedGroupId: null` while a wallet nobody chose was being
            // synced, which is not something anyone should have to infer.
            ...(restoredSelection === undefined || restoredSelection === null
              ? {actingOnFirstGroup: [...initialState.groups.keys()][0] ?? null}
              : {}),
            network,
          })

          // Subscribe for ongoing state changes (sync, balance updates, etc.).
          // Done after initial state is committed so load() callbacks don't race
          // with the startup selection reset above.
          const unsubscribe = subscribeToRef(walletService.state, () => {
            if (mounted) {
              updateFromServiceState(Effect.runSync(SubscriptionRef.get(walletService.state)))
            }
          })
          if (mounted) {
            unsubscribeRef.current = unsubscribe
          } else {
            unsubscribe()
          }

          // Retroactively attach checksums/profiles to groups loaded from storage that are missing them
          const groupsNeedingUpdate = [...initialState.groups.values()].filter((g) => !g.checksum || !g.profile)
          if (groupsNeedingUpdate.length > 0) {
            for (const group of groupsNeedingUpdate) {
              if (!mounted) break
              const firstChainId = group.chains.keys().next().value as ChainId | undefined
              if (firstChainId) {
                await attachChecksumAndProfile(group, firstChainId)
              }
            }
            // Re-read state after checksums were attached and persisted
            if (mounted) {
              const updatedState = await Effect.runPromise(walletService.getState())
              updateFromServiceState(updatedState)
            }
          }
        }
      } catch (e) {
        if (mounted) {
          const errorMessage = `Failed to initialize wallet service: ${String(e)}`
          logger.error(errorMessage, {origin: 'WalletProvider', cause: e})
          setError(errorMessage)
        }
      }
    }

    init()

    return () => {
      mounted = false
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
      // Close store on unmount to release database connections.
      if (walletServiceRef.current) {
        Effect.runPromise(walletServiceRef.current.close()).catch((e) =>
          logger.warn('Failed to close store on unmount', {origin: 'WalletProvider', error: e}),
        )
      }
    }
  }, [network, isNetworkLoading, updateFromServiceState, attachChecksumAndProfile])

  // ============================================================================
  // Stable Callback Implementations (using refs for stability)
  // ============================================================================

  /**
   * Run an async action with loading/error state management.
   * Reduces boilerplate for callbacks that follow the pattern:
   *   setIsLoading(true) -> setError(null) -> try/catch -> setIsLoading(false)
   *
   * @param action - Async function to execute
   * @param fallbackError - Default error message if the action fails
   * @param options - Optional: skip loading state (for background operations)
   */
  const runAction = useCallback(
    async <T,>(
      action: () => Promise<T>,
      fallbackError: string,
      options?: {skipLoading?: boolean},
    ): Promise<T | undefined> => {
      if (!options?.skipLoading) setIsLoading(true)
      setError(null)
      try {
        return await action()
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : fallbackError
        logger.error(errorMessage, {origin: 'WalletProvider', cause: e})
        setError(errorMessage)
        return undefined
      } finally {
        if (!options?.skipLoading) setIsLoading(false)
      }
    },
    [],
  )

  // selectWallet and selectAllBlockchains are provided by useWalletSelection above.

  /**
   * Hand the scheduler this group's DUST sync key, if this leg is the one that can.
   *
   * Populate-only and no prompt: the mnemonic is already in hand, so nothing here reads the enclave.
   * Shared by `createWallet` and `restoreWallet`, which build a group the same way — one chain at a
   * time — and so hit the same sequencing. {@link syncKeyAtCreate} documents what that broke.
   */
  const rememberDustSyncKey = useCallback(
    (group: {readonly groupId: string; readonly chains: ReadonlyMap<ChainId, unknown>}, mnemonic: string) => {
      const fundsNetwork = midnightFundsNetwork(network)
      const decision = syncKeyAtCreate({
        hasMidnight: [...group.chains.keys()].some(isMidnightChainId),
        fundsNetwork,
      })
      if (!decision.remember) {
        // `debug`, not `error`: both reasons are ordinary states of a half-built group, and reporting
        // them as defects put an error in the log of every single wallet creation.
        logger.debug('dust sync key not registered on this leg', {
          origin: 'WalletProvider',
          groupId: group.groupId,
          reason: decision.reason,
          chains: [...group.chains.keys()],
        })
        return
      }
      // Non-null by construction: `syncKeyAtCreate` only remembers when a funds network exists.
      void rememberSyncKeysForScheduler(group.groupId, 0, mnemonic, fundsNetwork as string)
    },
    [network],
  )

  const createWallet = useCallback(
    async (params: CreateWalletParams) => {
      const walletService = walletServiceRef.current
      if (!walletService) {
        throw new WalletError({message: 'Wallet service not initialized'})
      }

      logger.info('User creating new wallet', {origin: 'WalletProvider', name: params.name})
      setIsLoading(true)
      setError(null)
      try {
        const t0 = performance.now()
        // Watchdog: walletService.createWallet does the in-memory wallet
        // build — pre-derives xpubs for all configured chains (per-chain
        // logs in WalletManager) + ensures the requested chain's xpub.
        // Sub-second; warn if it hangs past 20s.
        const group = await watchdog(Effect.runPromise(walletService.createWallet(params)), {
          label: 'walletService.createWallet',
          thresholdMs: 20_000,
          context: {chainId: params.chainId, source: params.source ?? 'mnemonic'},
        })
        const tService = performance.now()
        logger.debug('Service createWallet done', {origin: 'WalletProvider', ms: Math.round(tService - t0)})

        const chainId = params.chainId ?? CARDANO_MAINNET
        // Enclave key ceremony — store the mnemonic in the OS keychain
        // (`BIOMETRY_ANY_OR_DEVICE_PASSCODE`). Only once per group (skip
        // if already stored from a previous chain's createWallet call).
        const {createEnclaveMnemonicVault} = await import('../services/credential-vault')
        const enclave = createEnclaveMnemonicVault()
        const hasEnclave = await Effect.runPromise(enclave.has(group.groupId).pipe(Effect.orElseSucceed(() => false)))
        if (!hasEnclave) {
          // NOTE: the DUST sync key is registered *below*, outside this guard — see `rememberDustSyncKey`.
          const tMnem = performance.now()
          await Effect.runPromise(enclave.store(group.groupId, params.mnemonic, biometricAuthPromptRef.current))
          // Cache the account's public keys now, while the mnemonic is in hand.
          // Deriving them needs the seed, so the only alternative is a biometric
          // prompt later — and the CIP-1854 xpub among them is what lets a shared
          // wallet's roster recognise this wallet as one of its co-signers. Derived
          // lazily, that answer is unavailable until the wallet happens to sign
          // something, which for a co-signer is exactly when it is first needed.
          // Best-effort: public data, and no reason to fail wallet creation over it.
          await Effect.runPromise(
            persistCardanoGovKeys(group.groupId, params.mnemonic).pipe(Effect.orElseSucceed(() => null)),
          )
          logger.debug('Mnemonic stored (enclave)', {
            origin: 'WalletProvider',
            groupId: group.groupId,
            ms: Math.round(performance.now() - tMnem),
          })
        }

        // ⚠️ **Outside the guard above, deliberately.** That guard runs once per group — on the leg
        // that first writes the enclave entry — and a group is built one chain at a time, so the
        // first leg is exactly the one with no Midnight chain. Registering in there meant the leg
        // that *could* remember the key was always the leg that skipped the block, and no new wallet
        // ever kept DUST current. `syncKeyAtCreate` carries the reasoning.
        rememberDustSyncKey(group, params.mnemonic)

        const tChecksum = performance.now()
        const walletWithChecksum = await attachChecksumAndProfile(group, chainId)
        logger.debug('Checksum attached', {origin: 'WalletProvider', ms: Math.round(performance.now() - tChecksum)})

        // Derive the receive address for the just-created chain and merge into
        // derivedGroupAddresses. Mirrors `enableChainForGroup` for the same
        // reason: the group-switch effect's dep is the groupId string, so it
        // doesn't re-fire when only `wallets` mutates. preparing.tsx calls
        // createWallet once per chain in `getDefaultChains()`; without this,
        // only the first chain's address survives the group-switch effect's
        // initial fan-out and every later chain's `receiveAddresses.get`
        // returns undefined — TransferProvider throws "No sender address
        // available for <chainId>" on Send/Swap. The group-switch
        // effect remains the primary writer on a true group switch; this is
        // the chain-add codepath equivalent the documented INVARIANT requires.
        Effect.runPromise(walletService.getReceiveAddress({groupId: group.groupId, chainId}))
          .then((addr) => setDerivedGroupAddresses((prev) => mergeChainAddress(prev, group.groupId, chainId, addr)))
          .catch((e) =>
            logger.warn('Failed to derive receive address after createWallet', {
              origin: 'WalletProvider',
              groupId: group.groupId,
              chainId,
              error: e,
            }),
          )

        logger.info('Wallet created successfully', {
          totalMs: Math.round(performance.now() - t0),
          origin: 'WalletProvider',
          groupId: group.groupId,
          name: group.name,
        })

        return walletWithChecksum
      } catch (e) {
        let errorMessage = 'Failed to create wallet'
        if (e instanceof Error && e.message) {
          errorMessage = e.message
        } else if (typeof e === 'string') {
          errorMessage = e
        } else if (e && typeof e === 'object') {
          const obj = e as Record<string, unknown>
          if (typeof obj.message === 'string') {
            errorMessage = obj.message
          } else if (typeof obj._tag === 'string') {
            errorMessage = `${obj._tag}: ${JSON.stringify(obj)}`
          }
        }
        logger.error(errorMessage, {origin: 'WalletProvider', name: params.name, cause: String(e)})
        setError(errorMessage)
        throw new Error(errorMessage)
      } finally {
        setIsLoading(false)
      }
    },
    [attachChecksumAndProfile, rememberDustSyncKey],
  )

  const restoreWallet = useCallback(
    async (params: CreateWalletParams) => {
      const walletService = walletServiceRef.current
      if (!walletService) {
        throw new WalletError({message: 'Wallet service not initialized'})
      }

      logger.info('User restoring wallet', {origin: 'WalletProvider', name: params.name})
      setIsLoading(true)
      setError(null)
      try {
        const group = await Effect.runPromise(walletService.restoreWallet(params))
        const chainId = params.chainId ?? CARDANO_MAINNET
        // Enclave key ceremony — same storage path as createWallet.
        const {createEnclaveMnemonicVault} = await import('../services/credential-vault')
        await Effect.runPromise(
          createEnclaveMnemonicVault().store(group.groupId, params.mnemonic, biometricAuthPromptRef.current),
        )
        rememberDustSyncKey(group, params.mnemonic)
        // Cache the account's public keys now, while the mnemonic is in hand.
        // Deriving them needs the seed, so the only alternative is a biometric
        // prompt later — and the CIP-1854 xpub among them is what lets a shared
        // wallet's roster recognise this wallet as one of its co-signers. Derived
        // lazily, that answer is unavailable until the wallet happens to sign
        // something, which for a co-signer is exactly when it is first needed.
        // Best-effort: public data, and no reason to fail wallet creation over it.
        await Effect.runPromise(
          persistCardanoGovKeys(group.groupId, params.mnemonic).pipe(Effect.orElseSucceed(() => null)),
        )
        const walletWithChecksum = await attachChecksumAndProfile(group, chainId)
        // Deselect to start with "All blockchains" view instead of defaulting to Cardano
        await Effect.runPromise(walletService.deselect())
        await Effect.runPromise(walletService.save())
        // Update React state immediately so the UI shows "All blockchains"
        setSelection(null)
        // Fire background sync for all chains (don't block restore flow)
        for (const ch of Array.from(group.chains.keys())) {
          Effect.runPromise(walletService.syncChainWallet(group.groupId, ch, {txMode: TX_FETCH_MODE.RECENT})).catch(
            (e) =>
              logger.warn('Initial sync after restore failed', {
                origin: 'WalletProvider',
                groupId: group.groupId,
                chainId: ch,
                error: String(e),
              }),
          )
        }
        logger.info('Wallet restored successfully', {
          origin: 'WalletProvider',
          groupId: group.groupId,
          name: group.name,
        })
        return walletWithChecksum
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : 'Failed to restore wallet'
        logger.error(errorMessage, {origin: 'WalletProvider', name: params.name, cause: e})
        setError(errorMessage)
        throw new Error(errorMessage)
      } finally {
        setIsLoading(false)
      }
    },
    [attachChecksumAndProfile, rememberDustSyncKey],
  )

  // Create a wallet group from a hardware device's pre-derived account xpubs.
  // No mnemonic/enclave — hardware keys never leave the device. `save()` does
  // not emit a creation state-change to subscribers, so re-read and push into
  // the React list here (same as createReadOnlyWallet) or the group is
  // persisted but never appears in the UI.
  const createFromDevice = useCallback(
    async (params: CreateFromDeviceContextParams): Promise<string> => {
      const walletService = walletServiceRef.current
      if (!walletService) throw new WalletError({message: 'Wallet service not initialized'})
      setIsLoading(true)
      setError(null)
      try {
        const chainId = params.chainId ?? CARDANO_MAINNET
        const group = await Effect.runPromise(
          walletService.walletManager.createFromDevice({
            name: params.name,
            publicKeys: params.publicKeys,
            chainId,
            deviceType: params.deviceType,
            source: 'hardware',
            ...(params.groupId ? {groupId: params.groupId as WalletGroupId} : {}),
          }),
        )
        await attachChecksumAndProfile(group, chainId)
        await Effect.runPromise(walletService.save())
        const state = await Effect.runPromise(walletService.getState())
        updateFromServiceState(state)
        return group.groupId
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : 'Failed to import hardware wallet'
        logger.error(errorMessage, {origin: 'WalletProvider', name: params.name, cause: String(e)})
        setError(errorMessage)
        throw new Error(errorMessage)
      } finally {
        setIsLoading(false)
      }
    },
    [attachChecksumAndProfile, updateFromServiceState],
  )

  const persistDeviceDeriveOnlyAddress = useCallback(
    async (params: {groupId: string; chain: DeriveOnlyChain; accountIndex: number; address: string}): Promise<void> => {
      const walletService = walletServiceRef.current
      if (!walletService) throw new WalletError({message: 'Wallet service not initialized'})
      await Effect.runPromise(walletService.persistDeviceDeriveOnlyAddress(params))
      await Effect.runPromise(walletService.save())
    },
    [],
  )

  const setDeviceXpubs = useCallback(
    async (
      groupId: string,
      entries: readonly {publicKey: Uint8Array; chainCode: Uint8Array; chainId: ChainId}[],
      accountIndex = 0,
    ): Promise<void> => {
      const walletService = walletServiceRef.current
      if (!walletService) throw new WalletError({message: 'Wallet service not initialized'})
      await Effect.runPromise(
        walletService.walletManager.setDeviceAccountXpubs(groupId as WalletGroupId, entries, accountIndex),
      )
      await Effect.runPromise(walletService.save())
    },
    [],
  )

  const addDeviceAccount = useCallback(
    async (
      groupId: string,
      chainId: ChainId,
      accountIndex: number,
      key: {publicKey: Uint8Array; chainCode: Uint8Array},
    ): Promise<void> => {
      const walletService = walletServiceRef.current
      if (!walletService) throw new WalletError({message: 'Wallet service not initialized'})
      await Effect.runPromise(
        walletService.walletManager.addDeviceAccount(groupId as WalletGroupId, chainId, accountIndex, key),
      )
      await Effect.runPromise(walletService.save())
      const state = await Effect.runPromise(walletService.getState())
      updateFromServiceState(state)
    },
    [updateFromServiceState],
  )

  const createReadOnlyWallet = useCallback(
    async (params: {name: string; addresses: readonly string[]; checksumSeed?: string}): Promise<string> => {
      const walletService = walletServiceRef.current
      if (!walletService) throw new WalletError({message: 'Wallet service not initialized'})
      setIsLoading(true)
      setError(null)
      try {
        const group = await Effect.runPromise(
          walletService.createReadOnlyCardanoWallet({
            name: params.name,
            addresses: params.addresses,
            ...(params.checksumSeed ? {checksumSeed: params.checksumSeed} : {}),
          }),
        )
        // Best-effort checksum/profile — no xpub, so this no-ops gracefully.
        await attachChecksumAndProfile(group, CARDANO_MAINNET)
        await Effect.runPromise(walletService.save())
        const state = await Effect.runPromise(walletService.getState())
        updateFromServiceState(state)
        return group.groupId
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : 'Failed to add read-only wallet'
        logger.error(errorMessage, {origin: 'WalletProvider', name: params.name, cause: String(e)})
        setError(errorMessage)
        throw new Error(errorMessage)
      } finally {
        setIsLoading(false)
      }
    },
    [attachChecksumAndProfile, updateFromServiceState],
  )

  /**
   * Register a shared wallet as a wallet group so it appears in the wallet list.
   *
   * Idempotent on the shared wallet's id, so re-running create for the same
   * wallet does not produce a second group.
   */
  const registerSharedWalletGroup = useCallback(
    async (params: {groupId: string; name: string; addresses: readonly string[]; checksumSeed?: string}) => {
      const walletService = walletServiceRef.current
      if (!walletService) throw new WalletError({message: 'Wallet service not initialized'})
      const group = await Effect.runPromise(
        walletService.createSharedWalletGroup({
          groupId: params.groupId,
          name: params.name,
          addresses: params.addresses,
          ...(params.checksumSeed ? {checksumSeed: params.checksumSeed} : {}),
        }),
      )
      await attachChecksumAndProfile(group, CARDANO_MAINNET)
      await Effect.runPromise(walletService.save())
      const state = await Effect.runPromise(walletService.getState())
      updateFromServiceState(state)
      return group.groupId
    },
    [attachChecksumAndProfile, updateFromServiceState],
  )

  const deleteWallet = useCallback(
    async (groupId: string) => {
      const walletService = walletServiceRef.current
      if (!walletService) {
        throw new WalletError({message: 'Wallet service not initialized'})
      }

      logger.info('User deleting wallet group', {origin: 'WalletProvider', groupId})
      await runAction(async () => {
        // Delete the enclave keychain entry — without this it outlives
        // wallet deletion (and, on iOS, app uninstall).
        try {
          const {createEnclaveMnemonicVault} = await import('../services/credential-vault')
          await Effect.runPromise(createEnclaveMnemonicVault().delete(groupId))
        } catch (e: unknown) {
          // Ordinarily "no entry" — hardware and read-only groups never had one. But a real
          // keychain failure reads the same here and leaves the seed behind after the wallet is
          // gone, so it must be visible rather than assumed benign.
          logger.warn('Enclave entry not deleted with its wallet group; it may still hold key material', {
            origin: 'WalletProvider',
            groupId,
            error: String(e),
          })
        }
        // The DUST keys go with it. Without this the deleted wallet's key sits in the book until some
        // later append happens to rewrite it, and the scheduler keeps trying to sync a wallet that is
        // gone.
        await Effect.runPromise(forgetDustKeysForGroup(groupId))
        await Effect.runPromise(walletService.deleteGroup(groupId as WalletGroupId))
        await Effect.runPromise(walletService.save())
        logger.info('Wallet group deleted', {origin: 'WalletProvider', groupId})
      }, 'Failed to delete wallet')
    },
    [runAction],
  )

  const deleteAllWalletData = useCallback(async () => {
    const walletService = walletServiceRef.current
    if (!walletService) {
      throw new WalletError({message: 'Wallet service not initialized'})
    }

    const state = await Effect.runPromise(walletService.getState())
    const {createEnclaveMnemonicVault} = await import('../services/credential-vault')
    const enclave = createEnclaveMnemonicVault()
    for (const groupId of state.groups.keys()) {
      try {
        await Effect.runPromise(enclave.delete(groupId))
      } catch (e: unknown) {
        logger.warn('Enclave entry not deleted during wipe; it may still hold key material', {
          origin: 'WalletProvider',
          groupId,
          error: String(e),
        })
      }
      await Effect.runPromise(walletService.deleteGroup(groupId))
    }
    await Effect.runPromise(walletService.save())

    // Not an empty book: a slot claiming a state that no longer exists is worse than no slot, and this
    // is the "erase this wallet" path — the same reasoning that takes the identity seed below.
    forgetAllSyncKeys()
    await Effect.runPromise(deleteDustKeyBook())

    // The identity seed and the passkey-wrapped cloud blob are NOT wallet
    // groups, so the loop above never reached them. Without these two the
    // screen that calls this ("erase this wallet") left the identity on the
    // device and the recovery blob in iCloud Keychain / Block Store, and the
    // account restored from another device — the reset promised more than it
    // did. Both are best-effort: a failure here must not strand the user in a
    // half-deleted state with no way forward.
    const {deleteIdentityMnemonic} = await import('../services/identity-wallet')
    await deleteIdentityMnemonic().catch((error: unknown) => {
      logger.warn('Identity seed delete failed during full reset', {origin: 'WalletProvider', error: String(error)})
    })

    const {removePasskeyRecovery} = await import('../services/passkey-recovery')
    await removePasskeyRecovery().catch((error: unknown) => {
      logger.warn('Cloud recovery blob delete failed during full reset', {
        origin: 'WalletProvider',
        error: String(error),
      })
    })

    logger.info('All wallet data deleted', {origin: 'WalletProvider'})
  }, [])

  const renameWallet = useCallback(
    async (groupId: string, newName: string) => {
      const walletService = walletServiceRef.current
      if (!walletService) throw new WalletError({message: 'Wallet service not initialized'})

      logger.info('User renaming wallet group', {origin: 'WalletProvider', groupId, name: newName})
      await Effect.runPromise(walletService.renameGroup(groupId as WalletGroupId, newName))
      // A shared wallet carries a second copy of its name, in the multisig
      // registry — and that is the one the composition screen shows, a re-share
      // sends to the other co-signers, and a publish writes on chain. Renaming
      // only the group left one wallet with two names, the wrong one public.
      const {platformSharedWalletRegistry} = await import('../services/cardano/multisig/storage')
      const wasShared = await Effect.runPromise(
        platformSharedWalletRegistry()
          .rename(groupId, newName)
          .pipe(
            Effect.catchAll((error) => {
              logger.warn('Shared wallet registry rename failed', {
                origin: 'WalletProvider',
                groupId,
                error: String(error),
              })
              return Effect.succeed(false)
            }),
          ),
      )
      if (wasShared) logger.info('Shared wallet record renamed', {origin: 'WalletProvider', groupId})
      await Effect.runPromise(walletService.save())
      const state = await Effect.runPromise(walletService.getState())
      updateFromServiceState(state)
      logger.info('Wallet group renamed', {origin: 'WalletProvider', groupId, name: newName})
    },
    [updateFromServiceState],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: `decryptMnemonicForWallet` is declared later in this body — adding it to the deps array would TDZ at render. The function is wrapped in useCallback with empty deps so its reference is stable; the closure picks it up at call time.
  const enableChainForGroup = useCallback(
    async (groupId: string, chainId: ChainId) => {
      const walletService = walletServiceRef.current
      if (!walletService) {
        throw new WalletError({message: 'Wallet service not initialized'})
      }

      logger.info('Enabling chain for wallet group', {origin: 'WalletProvider', groupId, chainId})
      return runAction(async () => {
        // Fast path: try enabling with no credential. If the xpub for
        // (groupId, chainId, 0) is already cached (the common case —
        // `createFromMnemonic` pre-derives for every chain in
        // the hardcoded identity chains at wallet creation), this returns the new
        // chain wallet without needing the mnemonic.
        let meta: ChainWallet | undefined
        try {
          meta = await Effect.runPromise(walletService.enableChain(groupId as WalletGroupId, chainId))
        } catch (e) {
          // Slow path: xpub not cached (e.g. a chain shipped in an app
          // update after this wallet was created). Retrieve the mnemonic
          // via the enclave vault (`decryptMnemonicForWallet` — fires the
          // OS biometric / passcode prompt) and hand it directly to
          // `enableChain`. The wallet-manager's legacy `mnemonicStore`-
          // based slow path isn't wired in production; this is the only
          // path that works for fresh chains on existing wallets.
          const isXpubNotFound = e instanceof Error && e.message.includes('XPUB_NOT_FOUND_AUTH_REQUIRED')
          if (!isXpubNotFound) throw e
          logger.info('enableChainForGroup: xpub not cached, decrypting mnemonic for slow path', {
            origin: 'WalletProvider',
            groupId,
            chainId,
          })
          const mnemonic = await decryptMnemonicForWallet(groupId)
          meta = await Effect.runPromise(walletService.enableChain(groupId as WalletGroupId, chainId, {mnemonic}))
        }
        await Effect.runPromise(walletService.save())
        const state = await Effect.runPromise(walletService.getState())
        updateFromServiceState(state)
        logger.info('Chain enabled for group', {origin: 'WalletProvider', groupId, chainId})

        // Derive the receive address for the newly enabled chain and merge it
        // into derivedGroupAddresses. Without this, `receiveAddresses.get(chainId)`
        // returns undefined for any chain added after group selection — the
        // group-switch effect's dep is the groupId string, so it does NOT
        // re-fire when only `wallets` mutates (the original root cause).
        Effect.runPromise(walletService.getReceiveAddress({groupId: groupId as WalletGroupId, chainId}))
          .then((addr) => setDerivedGroupAddresses((prev) => mergeChainAddress(prev, groupId, chainId, addr)))
          .catch((e) =>
            logger.warn('Failed to derive receive address after chain enable', {
              origin: 'WalletProvider',
              groupId,
              chainId,
              error: e,
            }),
          )

        // Fire background sync for recently enabled chain (don't block enable flow)
        Effect.runPromise(
          walletService.syncChainWallet(groupId as WalletGroupId, chainId, {txMode: TX_FETCH_MODE.RECENT}),
        )
          .then(async () => {
            const updatedState = await Effect.runPromise(walletService.getState())
            updateFromServiceState(updatedState)
          })
          .catch((e) =>
            logger.warn('Background sync after chain enable failed', {origin: 'WalletProvider', groupId, chainId, e}),
          )

        return meta
      }, 'Failed to enable chain')
    },
    [runAction, updateFromServiceState],
  )

  const disableChainForGroup = useCallback(
    async (groupId: string, chainId: ChainId) => {
      const walletService = walletServiceRef.current
      if (!walletService) {
        throw new WalletError({message: 'Wallet service not initialized'})
      }

      logger.info('Disabling chain for wallet group', {origin: 'WalletProvider', groupId, chainId})
      const ok = await runAction(async () => {
        await Effect.runPromise(walletService.disableChain(groupId as WalletGroupId, chainId))
        await Effect.runPromise(walletService.save())
        const state = await Effect.runPromise(walletService.getState())
        updateFromServiceState(state)
        logger.info('Chain disabled for group', {origin: 'WalletProvider', groupId, chainId})
        return true as const
      }, 'Failed to disable chain')
      if (!ok) {
        throw new Error('Failed to disable chain')
      }
    },
    [runAction, updateFromServiceState],
  )

  const scanAccountsFromXPubsFn = useCallback(
    async (
      groupId: string,
      chainId: ChainId,
      xpubs: ReadonlyArray<{readonly index: number; readonly xpub: Uint8Array}>,
    ): Promise<ChainWallet> => {
      const walletService = walletServiceRef.current
      if (!walletService) throw new WalletError({message: 'Wallet service not initialized'})

      await Effect.runPromise(
        walletService.walletManager.scanAccountsFromXPubs(groupId as WalletGroupId, chainId, xpubs),
      )
      await Effect.runPromise(walletService.save())
      const state = await Effect.runPromise(walletService.getState())
      updateFromServiceState(state)
      const group = state.groups.get(groupId as WalletGroupId)
      if (!group) throw new WalletError({message: 'Group not found after scan'})
      const meta = toChainWallet(group, chainId)
      if (!meta) throw new WalletError({message: 'Chain not found after scan'})
      return meta
    },
    [updateFromServiceState],
  )

  const enableAccountFn = useCallback(
    async (groupId: string, chainId: ChainId, accountIndex: number): Promise<ChainWallet> => {
      const walletService = walletServiceRef.current
      if (!walletService) throw new WalletError({message: 'Wallet service not initialized'})

      await Effect.runPromise(
        walletService.walletManager.enableAccount(groupId as WalletGroupId, chainId, accountIndex),
      )
      await Effect.runPromise(walletService.save())
      const state = await Effect.runPromise(walletService.getState())
      updateFromServiceState(state)
      const group = state.groups.get(groupId as WalletGroupId)
      if (!group) throw new WalletError({message: 'Group not found'})
      const meta = toChainWallet(group, chainId)
      if (!meta) throw new WalletError({message: 'Chain not found'})
      return meta
    },
    [updateFromServiceState],
  )

  const disableAccountFn = useCallback(
    async (groupId: string, chainId: ChainId, accountIndex: number): Promise<ChainWallet> => {
      const walletService = walletServiceRef.current
      if (!walletService) throw new WalletError({message: 'Wallet service not initialized'})

      await Effect.runPromise(
        walletService.walletManager.disableAccount(groupId as WalletGroupId, chainId, accountIndex),
      )
      // A disabled account is one the scheduler has no business syncing, so its key leaves the book
      // too. Re-enabling derives it again from the seed, which is a prompt the user is answering.
      if (isMidnightChainId(chainId)) {
        await Effect.runPromise(forgetDustKeyForAccount(groupId, accountIndex))
      }
      await Effect.runPromise(walletService.save())
      const state = await Effect.runPromise(walletService.getState())
      updateFromServiceState(state)
      const group = state.groups.get(groupId as WalletGroupId)
      if (!group) throw new WalletError({message: 'Group not found'})
      const meta = toChainWallet(group, chainId)
      if (!meta) throw new WalletError({message: 'Chain not found'})
      return meta
    },
    [updateFromServiceState],
  )

  const refreshBalance = useCallback(async () => {
    const service = walletServiceRef.current
    if (!service || !selectionRef.current) return

    logger.info('User refreshing balance', {origin: 'WalletProvider', groupId: selectionRef.current.groupId})
    await runAction(async () => {
      await Effect.runPromise(service.sync())
    }, 'Failed to refresh balance')
  }, [runAction])

  const syncWallet = useCallback(async () => {
    const service = walletServiceRef.current
    if (!service) return

    // Resolve the active wallet group. On a single-chain page selectionRef
    // points at the selected chain; on the "All Blockchains" aggregate page
    // selectionRef is null but activeGroupRef still tracks the group.
    const group = activeGroupRef.current
    if (!group) {
      logger.debug('No wallet group available, skipping sync', {origin: 'WalletProvider'})
      return
    }

    const groupId = group.groupId as WalletGroupId

    logger.debug('Syncing all chains in wallet group', {
      origin: 'WalletProvider',
      groupId,
      chainCount: group.chains.length,
    })

    await runAction(
      async () => {
        // Sync every chain in the active group so all balances update,
        // not just the currently-selected chain.
        const chainIds = group.chains
        const results = await Promise.all(
          chainIds.map((chainId) =>
            Effect.runPromise(
              service.syncChainWallet(groupId, chainId, {txMode: TX_FETCH_MODE.ALL}).pipe(
                Effect.match({
                  onSuccess: () => ({ok: true as const}),
                  onFailure: (error) => ({ok: false as const, message: error.message}),
                }),
              ),
            ),
          ),
        )

        const now = Date.now()
        setChainSyncStates((prev) => reconcileRefreshedSyncStates({prev, groupId, chainIds, results, now}))
      },
      'Failed to sync wallet',
      {skipLoading: true},
    )
  }, [runAction])

  const syncWalletById = useCallback(
    async (groupId: string, chainId: ChainId, options?: {txMode?: TxFetchMode}) => {
      const service = walletServiceRef.current
      if (!service) return

      // Include txMode — a 'recent' (light) sync in flight must NOT absorb an
      // 'all' (full-history) request, or full history never runs and the
      // activity screen stays stuck on the recent page. Default to ALL to match
      // what actually runs downstream: an unspecified txMode is forwarded to
      // syncChainWallet → syncWalletForChain, which defaults to ALL. Keying it
      // RECENT would mislabel a full sync and let a recent caller join it (or
      // split two full syncs). Mirrors wallet-service's syncChainWallet dedup.
      const dedupKey = `${groupId}:${chainId}:${options?.txMode ?? TX_FETCH_MODE.ALL}`

      // Dedup: if a sync is already in progress for this wallet, await it instead of starting a new one.
      const existing = activeSyncsRef.current.get(dedupKey)
      if (existing) {
        logger.debug('Sync already in progress, reusing', {origin: 'WalletProvider', groupId, chainId})
        await existing
        return
      }

      logger.debug('Syncing wallet by ID', {origin: 'WalletProvider', groupId, chainId})
      const syncPromise = runAction(
        async () => {
          await Effect.runPromise(service.syncChainWallet(groupId as WalletGroupId, chainId, options))
        },
        'Failed to sync wallet',
        {skipLoading: true},
      ).finally(() => {
        activeSyncsRef.current.delete(dedupKey)
      })
      activeSyncsRef.current.set(dedupKey, syncPromise as Promise<void>)
      await syncPromise
    },
    [runAction],
  )

  const syncChain = useCallback(async (chainId: ChainId) => {
    const service = walletServiceRef.current
    if (!service || !selectionRef.current) return

    logger.debug('Syncing chain', {origin: 'WalletProvider', groupId: selectionRef.current.groupId, chainId})
    setError(null)
    try {
      await Effect.runPromise(service.syncChain(chainId))
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : `Failed to sync chain ${chainId}`
      logger.error(errorMessage, {origin: 'WalletProvider', cause: e})
      setError(errorMessage)
    }
  }, [])

  // Adaptive per-chain sync — each chain in the active wallet group gets its
  // own Effect fiber with independent scheduling. Only the active group is synced
  // to avoid unnecessary backend calls for non-selected wallets.
  //
  // Keyed off the active group rather than `selection?.groupId` so that the
  // "All networks" aggregate view (selection = null) still syncs — otherwise
  // tx sync only kicks in once the user drills into a specific chain.
  //
  // Restarts when isReady, the active group changes, or group chains change.
  const activeGroupId = selectedWalletGroup?.groupId ?? null
  const activeGroupChainsKey = useMemo(() => {
    if (!activeGroupId) return ''
    const group = groups.get(activeGroupId as WalletGroupId)
    if (!group) return ''
    return [...group.chains.keys()].sort().join(',')
  }, [groups, activeGroupId])

  const pollFiberRef = useRef<import('effect/Fiber').RuntimeFiber<void, never> | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: activeGroupChainsKey triggers restart when active group or its chains change
  useEffect(() => {
    if (!isReady) return
    if (!activeGroupId) return
    const currentGroups = groupsRef.current
    const activeGroup = currentGroups.get(activeGroupId as WalletGroupId)
    if (!activeGroup) return
    const service = walletServiceRef.current
    if (!service) return

    // Only sync chains belonging to the active wallet group.
    const chains: {groupId: WalletGroupId; chainId: ChainId}[] = []
    for (const chainId of activeGroup.chains.keys()) {
      chains.push({groupId: activeGroup.groupId, chainId})
    }

    // Create and start the scheduler.
    // Use an abort flag to handle the race where cleanup fires before async setup completes.
    let aborted = false

    void Effect.runPromise(
      Effect.gen(function* () {
        const scheduler = yield* createChainSyncScheduler()
        if (aborted) {
          yield* scheduler.stop()
          return
        }
        schedulerRef.current = scheduler

        // Tx confirmation checker — uses loadTransaction for O(1) key lookup
        const txChecker: TxConfirmationChecker = (groupId, chainId, txHash) =>
          service
            .loadTransaction(groupId, chainId, txHash)
            .pipe(Effect.map((tx) => tx != null && tx.status !== 'pending'))

        yield* scheduler.start(
          chains,
          activeGroupId as WalletGroupId,
          (groupId, chainId) =>
            Effect.gen(function* () {
              // Capture pre-sync fingerprint
              const key = `${groupId}:${chainId}:0`
              const state = yield* service.getState()
              const beforeSnap = state.snapshots.get(key as SnapshotKey)
              const beforeFP = beforeSnap ? snapshotFingerprint(beforeSnap) : ''

              yield* service.syncChainWallet(groupId, chainId, {txMode: TX_FETCH_MODE.ALL})

              // ⚠️ `syncChainWallet` reads a cached snapshot; it does not reach a chain (see
              // `services/chain-sync`). Cardano's rail fetches elsewhere, Midnight's unshielded rail had
              // nothing doing it on a schedule at all — so it was refreshed only when a hook mounted,
              // which is what left one surface disagreeing with another until a restart. The shielded
              // and DUST rails stay off the schedule deliberately: they need role keys, and a timer
              // that triggers a fingerprint prompt is not a refresh.
              // ⚠️ Not read off the chain id. There is one Midnight chain id and it names the identity
              // chain, so the funds network has to come from config the way it does everywhere else.
              const midnightNetwork = isMidnightChainId(chainId) ? midnightFundsNetwork(network) : null
              // ⚠️ **The *selected* account, not account 0.** This used to hardcode 0 in all three calls
              // below, so a wallet sitting on any other account was never kept current at all — and
              // nothing failed, which is why testing on account 0 could never show it.
              //
              // Read from the ref at tick time rather than taken as a dependency: making the effect
              // depend on the selection would tear down and restart the *whole* chain-sync scheduler,
              // Cardano included, on every account switch.
              //
              // Active account only, deliberately. A background account's DUST cannot pay its own fees
              // until you visit it, which is the trade for not running one native rebuild per account.
              const activeAccountIndex =
                selectionRef.current?.groupId === groupId ? selectionRef.current.accountIndex : 0
              const midnightChanged =
                midnightNetwork === null
                  ? false
                  : yield* service.getReceiveAddress({groupId, chainId, accountIndex: activeAccountIndex}).pipe(
                      Effect.flatMap((address) =>
                        // DUST after the unshielded set. It needs a role key, which the key book now
                        // restores at unlock — so unlike before, this genuinely runs without a prompt.
                        Effect.zipWith(
                          syncMidnightUnshielded({
                            groupId,
                            accountIndex: activeAccountIndex,
                            chainId,
                            address,
                            network: midnightNetwork,
                          }),
                          syncScheduledDust({
                            groupId,
                            accountIndex: activeAccountIndex,
                            chainId,
                            network: midnightNetwork,
                          }),
                          (unshielded, dust) => unshielded || dust,
                        ),
                      ),
                      // No address stored for this network is an ordinary state for a wallet that has
                      // never had one derived — not a sync failure, and not something to retry harder.
                      Effect.catchAll((e) =>
                        Effect.sync(() => {
                          logger.debug('no midnight address to sync an unshielded set for', {
                            origin: 'WalletProvider',
                            chainId,
                            reason: e instanceof Error ? e.message : String(e),
                          })
                          return false
                        }),
                      ),
                    )

              // ⚠️ **One background wallet per tick, after the active one.** Only the active group is
              // scheduled (see above), so a wallet you are not looking at was refreshed by nothing at
              // all — a granted agent scope read a twelve-hour-old balance on 2026-08-29 for exactly
              // that reason. This drains the stalest one, one per tick, so the active wallet's own
              // sync is never behind N others. Failures are already swallowed per wallet inside
              // `syncMidnightUnshielded`.
              if (midnightNetwork !== null) {
                // ⚠️ **Read each group's enabled accounts; never assume account 0.** `AccountEntry`
                // carries `enabled` precisely because a wallet can sync more than one, and a pinned
                // index reads the wrong account with nothing failing — the class
                // `no-pinned-account.test.ts` exists to stop, and which it caught here.
                const candidates = enabledAccountsOn(currentGroups.values(), chainId)
                for (const due of dueForBackgroundSync({
                  candidates,
                  activeKey: freshnessKey(groupId, activeAccountIndex),
                  lastSyncedAt: syncFreshness(),
                  now: Date.now(),
                })) {
                  yield* service
                    .getReceiveAddress({
                      groupId: due.groupId as WalletGroupId,
                      chainId,
                      accountIndex: due.accountIndex,
                    })
                    .pipe(
                      Effect.flatMap((address) =>
                        syncMidnightUnshielded({
                          groupId: due.groupId,
                          accountIndex: due.accountIndex,
                          chainId,
                          address,
                          network: midnightNetwork,
                        }),
                      ),
                      // A background wallet that cannot be caught up must never fail the tick for the
                      // wallet the user is actually looking at.
                      Effect.catchAll((e) =>
                        Effect.sync(() => {
                          logger.debug('a background midnight wallet could not be caught up', {
                            origin: 'WalletProvider',
                            groupId: due.groupId,
                            reason: e instanceof Error ? e.message : String(e),
                          })
                          return false
                        }),
                      ),
                    )
                }
              }

              // ⚠️ **Cardano's own leg.** The comment above says `syncChainWallet` reaches no
              // chain and that "Cardano's rail fetches elsewhere" — elsewhere being four
              // screens. So a Cardano balance was refreshed only while a surface using it was
              // mounted, which is the "loads, shows a stale figure, needs a force refresh"
              // report. Scheduled here alongside Midnight's, for the active account only, on
              // the same terms.
              const cardanoChanged = isCardanoChainId(chainId)
                ? yield* service.getReceiveAddress({groupId, chainId, accountIndex: activeAccountIndex}).pipe(
                    Effect.flatMap((address) => {
                      // A read-only or shared wallet builds its rail by another route and with
                      // another ownership mode; resolving one here would fetch under the wrong
                      // rule. Skipped out loud — they keep the screen-driven refresh.
                      const group = currentGroups.get(groupId)
                      const kind = {
                        source: group?.source ?? 'mnemonic',
                        implementation: group?.chains.get(chainId)?.implementation,
                      }
                      if (!cardanoRailSyncIsSupported(kind)) {
                        logger.debug('cardano rail sync skipped for this wallet kind', {
                          origin: 'WalletProvider',
                          groupId,
                          source: kind.source,
                          implementation: kind.implementation,
                        })
                        return Effect.succeed(false)
                      }
                      return syncCardanoRail({groupId, chainId, accountIndex: activeAccountIndex, address})
                    }),
                    Effect.catchAll((e) =>
                      Effect.sync(() => {
                        logger.debug('no cardano address to sync a rail for', {
                          origin: 'WalletProvider',
                          chainId,
                          reason: e instanceof Error ? e.message : String(e),
                        })
                        return false
                      }),
                    ),
                  )
                : false

              // Compare post-sync fingerprint to detect real changes
              const afterState = yield* service.getState()
              const afterSnap = afterState.snapshots.get(key as SnapshotKey)
              const afterFP = afterSnap ? snapshotFingerprint(afterSnap) : ''
              return midnightChanged || cardanoChanged || afterFP !== beforeFP
            }).pipe(Effect.catchAll((e) => Effect.fail(new Error(e instanceof Error ? e.message : String(e))))),
          txChecker,
        )

        if (aborted) {
          yield* scheduler.stop()
          schedulerRef.current = null
          return
        }

        // Poll scheduler state and push to React state.
        // Adaptive rate: 500ms when any chain is syncing, 5s when all idle.
        // Only triggers setState when the state actually changes (shallow compare).
        // Subscribed, not polled. This used to re-serialise the whole state map every 500 ms while any
        // chain was syncing, purely to notice a status flip in Effect-held state — `scheduler.states`
        // is a `SubscriptionRef`, so the flip can announce itself. The comparison stays, because a
        // change to a field React does not render is still a wasted re-render.
        let prevStatesJson = ''
        const fiber = yield* Stream.runForEach(scheduler.states.changes, (states) =>
          Effect.sync(() => {
            const json = JSON.stringify([...states].map(([k, v]) => [k, v.status, v.lastChanged, v.lastError]))
            if (json === prevStatesJson) return
            prevStatesJson = json
            setChainSyncStates(states)
          }),
        ).pipe(
          // A failed subscription must not take the scheduler down with it: the fibers keep syncing,
          // only the on-screen status stops updating, and that is worth logging rather than crashing.
          Effect.catchAllCause((cause) =>
            Effect.sync(() => {
              logger.warn('the sync-state subscription ended; status will stop updating on screen', {
                origin: 'WalletProvider',
                cause: String(cause),
              })
            }),
          ),
          Effect.forkDaemon,
        )
        pollFiberRef.current = fiber
      }),
    ).catch((e) => logger.error('Failed to start chain sync scheduler', {origin: 'WalletProvider', error: e}))

    return () => {
      aborted = true
      const scheduler = schedulerRef.current
      if (scheduler) {
        void Effect.runPromise(scheduler.stop()).catch((e) => {
          logger.warn('Chain sync scheduler did not stop cleanly', {origin: 'WalletProvider', error: String(e)})
        })
        schedulerRef.current = null
      }
      const pollFiber = pollFiberRef.current
      if (pollFiber) {
        void Effect.runPromise(Fiber.interrupt(pollFiber)).catch((e) => {
          logger.warn('Sync poll fiber did not interrupt cleanly', {origin: 'WalletProvider', error: String(e)})
        })
        pollFiberRef.current = null
      }
    }
  }, [isReady, activeGroupId, activeGroupChainsKey])

  const boostChainSync = useCallback((groupId: string, chainId: ChainId, txHash?: string) => {
    const scheduler = schedulerRef.current
    if (!scheduler) return
    void Effect.runPromise(scheduler.boostChain(groupId as WalletGroupId, chainId, txHash)).catch((e) => {
      logger.warn('Failed to boost chain sync; the chain keeps its normal cadence', {
        origin: 'WalletProvider',
        groupId,
        chainId,
        error: String(e),
      })
    })
  }, [])

  const clearError = useCallback(() => {
    setError(null)
  }, [])

  const getUtxos = useCallback(
    async (params?: {
      readonly groupId?: string
      readonly chainId?: ChainId
      readonly accountIndex?: number
    }): Promise<readonly UTxO.UTxO[]> => {
      const service = walletServiceRef.current
      if (!service) return []

      // chainId is per-screen — must be provided by the caller. The groupId
      // can fall back to the user's currently-selected group.
      const sel = selectionRef.current
      const groupId = params?.groupId ?? sel?.groupId
      const chainId = params?.chainId
      if (!groupId || !chainId) return []
      // accountIndex is per-group: only inherit the selection's index when
      // the resolved group matches it, otherwise default to 0.
      const accountIndex = params?.accountIndex ?? (sel && groupId === sel.groupId ? sel.accountIndex : 0)

      try {
        const rows = await Effect.runPromise(service.listUtxos(groupId as WalletGroupId, chainId, accountIndex))
        return rows.map((r) =>
          storedToUtxo({
            txHash: r.txHash,
            txIndex: r.txIndex,
            address: r.address,
            quantity: r.quantity,
            assets: r.assets,
          }),
        )
      } catch (e: unknown) {
        logger.warn('Stored UTxOs unreadable; reporting none, which is not the same as holding none', {
          origin: 'WalletProvider',
          groupId,
          chainId,
          accountIndex,
          error: String(e),
        })
        return []
      }
    },
    [],
  )

  const getReceiveAddress = useCallback(
    async (params?: {
      readonly groupId?: string
      readonly chainId?: ChainId
      readonly accountIndex?: number
      readonly addressIndex?: number
    }): Promise<string> => {
      const service = walletServiceRef.current
      if (!service) {
        throw new WalletError({message: 'Wallet service not initialized'})
      }
      if (!params && !selectionRef.current) {
        throw new WalletError({message: 'No wallet selected'})
      }

      // Resolve mergeGroupId BEFORE the await so a concurrent group switch
      // can't label group A's address as group B's. The service reads its
      // selection state at Effect-start (wallet-service.ts:1220-1224), so
      // we must snapshot the same start-time groupId here.
      const mergeGroupId = params?.groupId ?? selectionRef.current?.groupId
      const mergeChainId = params?.chainId
      const mergeEligible =
        !!mergeGroupId &&
        !!mergeChainId &&
        params?.accountIndex === undefined &&
        params?.addressIndex === undefined &&
        // Only seed receiveAddresses for chains the group has actually
        // enabled. Software wallets pre-derive xpubs for every chain, so a
        // raw `getReceiveAddress({groupId, chainId})` would succeed for a
        // not-yet-enabled chain and SwapProvider would treat it as
        // available, bypassing the activation prompt.
        groupsRef.current.get(mergeGroupId as WalletGroupId)?.chains.has(mergeChainId) === true

      try {
        const addr = ensureReceiveAddressValue(
          await Effect.runPromise(
            service.getReceiveAddress(
              params
                ? {
                    ...(params.groupId ? {groupId: params.groupId as WalletGroupId} : {}),
                    ...(params.chainId ? {chainId: params.chainId} : {}),
                    ...(params.accountIndex != null ? {accountIndex: params.accountIndex} : {}),
                    ...(params.addressIndex != null ? {addressIndex: params.addressIndex} : {}),
                  }
                : undefined,
            ),
          ),
          {chainId: mergeChainId},
        )
        // Merge on-demand derivations into derivedGroupAddresses so callers
        // that later read receiveAddresses (prepare-swap-payload,
        // TransferProvider, hardware ensureReady) find the address. Without
        // this, SwapProvider's on-demand src/dest derivation produced an
        // addr for the routing request but receiveAddresses stayed empty
        // for opt-in chains (Tron, Solana, etc.), and prepareSwapPayload
        // threw "No sender address for tron: signerId is null and no
        // wallet address for tron:mainnet" when the routing backend
        // returned a trade without signerId.
        if (mergeEligible && mergeGroupId && mergeChainId) {
          setDerivedGroupAddresses((prev) => mergeChainAddress(prev, mergeGroupId, mergeChainId, addr))
        }
        return addr
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : 'Failed to get receive address'
        logger.error(errorMessage, {origin: 'WalletProvider', cause: e})
        // Preserve the original error identity (notably `ReceiveAddressInvalidError`
        // from ensureReceiveAddressValue) so downstream classifiers can read `name`.
        // Flattening to a bare Error dropped the name and reclassified the
        // transient EOA-unavailable race as a terminal failure.
        throw e instanceof Error ? e : new Error(errorMessage)
      }
    },
    [],
  )

  const getChangeAddress = useCallback(
    async (params?: {
      readonly groupId?: string
      readonly chainId?: ChainId
      readonly accountIndex?: number
    }): Promise<string> => {
      const service = walletServiceRef.current
      if (!service) {
        throw new WalletError({message: 'Wallet service not initialized'})
      }
      if (!params && !selectionRef.current) {
        throw new WalletError({message: 'No wallet selected'})
      }

      try {
        return await Effect.runPromise(
          service.getChangeAddress(
            params
              ? {
                  ...(params.groupId ? {groupId: params.groupId as WalletGroupId} : {}),
                  ...(params.chainId ? {chainId: params.chainId} : {}),
                  ...(params.accountIndex != null ? {accountIndex: params.accountIndex} : {}),
                }
              : undefined,
          ),
        )
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : 'Failed to get change address'
        logger.error(errorMessage, {origin: 'WalletProvider', cause: e})
        throw new Error(errorMessage)
      }
    },
    [],
  )

  const getStakeAddress = useCallback(async (): Promise<string> => {
    const service = walletServiceRef.current
    if (!service || !selectionRef.current) {
      throw new WalletError({message: 'No wallet selected'})
    }

    try {
      return await Effect.runPromise(service.getStakeAddress())
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Failed to get stake address'
      logger.error(errorMessage, {origin: 'WalletProvider', cause: e})
      throw new Error(errorMessage)
    }
  }, [])

  const getUsedAddresses = useCallback(async (): Promise<readonly string[]> => {
    const service = walletServiceRef.current
    if (!service || !selectionRef.current) return []

    try {
      return await Effect.runPromise(service.getUsedAddresses())
    } catch (e) {
      logger.error('Failed to get used addresses', {origin: 'WalletProvider', cause: e})
      return []
    }
  }, [])

  const getUnusedAddresses = useCallback(async (): Promise<readonly string[]> => {
    const service = walletServiceRef.current
    if (!service || !selectionRef.current) return []

    try {
      return await Effect.runPromise(service.getUnusedAddresses())
    } catch (e) {
      logger.error('Failed to get unused addresses', {origin: 'WalletProvider', cause: e})
      return []
    }
  }, [])

  const getUsedAddressesIndexed = useCallback(async (): Promise<readonly IndexedAddress[]> => {
    const service = walletServiceRef.current
    if (!service || !selectionRef.current) return []

    try {
      return await Effect.runPromise(service.getUsedAddressesIndexed())
    } catch (e) {
      logger.error('Failed to get indexed used addresses', {origin: 'WalletProvider', cause: e})
      return []
    }
  }, [])

  const getUnusedAddressesIndexed = useCallback(async (): Promise<readonly IndexedAddress[]> => {
    const service = walletServiceRef.current
    if (!service || !selectionRef.current) return []

    try {
      return await Effect.runPromise(service.getUnusedAddressesIndexed())
    } catch (e) {
      logger.error('Failed to get indexed unused addresses', {origin: 'WalletProvider', cause: e})
      return []
    }
  }, [])

  const getInternalAddressesIndexed = useCallback(async (): Promise<readonly IndexedAddress[]> => {
    const service = walletServiceRef.current
    if (!service || !selectionRef.current) return []

    try {
      return await Effect.runPromise(service.getInternalAddressesIndexed())
    } catch (e) {
      logger.error('Failed to get indexed internal addresses', {origin: 'WalletProvider', cause: e})
      return []
    }
  }, [])

  // The OS biometric / device-passcode prompt fires inside the vault retrieve and
  // surfaces to the user at this point in the flow. The enclave vault's ceremony
  // cache (see `ceremony-cache.ts`) suppresses repeat prompts inside a multi-sign
  // ceremony. The vault-error → typed-error mapping lives in `group-seed.ts` so
  // this provider and the other seed callers cannot drift apart on it.
  const decryptMnemonicForWallet = useCallback(
    (groupId: string): Promise<string> => retrieveGroupMnemonicForChainEnable(groupId, biometricAuthPromptRef.current),
    [],
  )

  const getAccountXPub = useCallback(
    async (chainId?: ChainId, groupId?: string, accountIndex?: number): Promise<Uint8Array> => {
      const service = walletServiceRef.current
      const sel = selectionRef.current
      // chainId is per-screen — must be provided by the caller. groupId and
      // accountIndex can fall back to the user's currently-selected group.
      const effectiveGroupId = groupId ?? sel?.groupId
      const effectiveChainId = chainId
      const effectiveAccountIndex = accountIndex ?? sel?.accountIndex
      if (!service || !effectiveGroupId || !effectiveChainId || effectiveAccountIndex == null) {
        throw new WalletError({message: 'getAccountXPub requires groupId and chainId'})
      }

      return await Effect.runPromise(
        service.walletManager.getXPub(effectiveGroupId as WalletGroupId, effectiveChainId, effectiveAccountIndex),
      )
    },
    [],
  )

  const getBalanceForChain = useCallback(
    (chainId: ChainId): WalletBalance | null => {
      return balancesByChain.get(chainId) ?? null
    },
    [balancesByChain],
  )

  const getSnapshotForWallet = useCallback(
    async (groupId: string, chainId: ChainId, accountIndex?: number): Promise<WalletSnapshot | null> => {
      const service = walletServiceRef.current
      if (!service) return null

      try {
        return await Effect.runPromise(service.loadSnapshot(groupId as WalletGroupId, chainId, accountIndex))
      } catch (e: unknown) {
        logger.warn('Wallet snapshot unreadable; reporting none, which reads as a wallet never synced', {
          origin: 'WalletProvider',
          groupId,
          chainId,
          accountIndex,
          error: String(e),
        })
        return null
      }
    },
    [],
  )

  const getTransactionForWallet = useCallback(
    async (groupId: string, chainId: ChainId, txHash: string): Promise<StoredTransaction | null> => {
      const service = walletServiceRef.current
      if (!service) return null

      try {
        return await Effect.runPromise(service.loadTransaction(groupId as WalletGroupId, chainId, txHash))
      } catch (e: unknown) {
        logger.warn('Stored transaction unreadable; reporting none, which reads as a transaction we never saw', {
          origin: 'WalletProvider',
          groupId,
          chainId,
          txHash,
          error: String(e),
        })
        return null
      }
    },
    [],
  )

  /**
   * ⚠️ **The account is named, never defaulted.** This passed a literal `0` while accepting no account
   * at all, so it could only ever read the first account's history — the implicit-account-index bug
   * this app has paid for six times.
   *
   * ⚠️ **And it rejects rather than answering `[]`.** A store that could not be read and a wallet with
   * no transactions are different facts; a caller that wants to render nothing for both has to say so.
   */
  const listTransactionRowsForWallet = useCallback(
    async (
      groupId: string,
      chainId: ChainId,
      accountIndex: number,
      query?: {readonly limit?: number; readonly offset?: number; readonly olderThan?: number},
    ): Promise<readonly TxListItem[]> => {
      const service = walletServiceRef.current
      if (!service) throw new Error('the wallet service is not open')
      return await Effect.runPromise(
        service.listTransactionRows(groupId as WalletGroupId, chainId, accountIndex, query),
      )
    },
    [],
  )

  const getTokenMetadata = useCallback(
    async (tokenIds: readonly string[]): Promise<ReadonlyMap<string, {data: unknown; fetchedAt: number}>> => {
      const service = walletServiceRef.current
      if (!service) return new Map()
      try {
        return await Effect.runPromise(service.getTokenMetadata(tokenIds))
      } catch (e: unknown) {
        logger.warn('Token metadata unreadable; every token renders unnamed rather than unfetched', {
          origin: 'WalletProvider',
          tokens: tokenIds.length,
          error: String(e),
        })
        return new Map()
      }
    },
    [],
  )

  const saveTokenMetadata = useCallback(
    async (entries: readonly {tokenId: string; data: unknown}[], now: number): Promise<void> => {
      const service = walletServiceRef.current
      if (!service) return
      try {
        await Effect.runPromise(service.saveTokenMetadata(entries, now))
      } catch (e) {
        logger.warn('saveTokenMetadata failed', {origin: 'WalletProvider', error: String(e)})
      }
    },
    [],
  )

  const listAssetsForWallet = useCallback(
    async (groupId: string, accountIndex: number): Promise<readonly AssetRow[]> => {
      const service = walletServiceRef.current
      if (!service) return []
      try {
        return await Effect.runPromise(service.listAssetRows(groupId as WalletGroupId, CARDANO_MAINNET, accountIndex))
      } catch (e: unknown) {
        logger.warn('Stored assets unreadable; reporting none, which is not the same as holding none', {
          origin: 'WalletProvider',
          groupId,
          accountIndex,
          error: String(e),
        })
        return []
      }
    },
    [],
  )

  const saveAssetsForWallet = useCallback(
    async (groupId: string, accountIndex: number, rows: readonly AssetRow[]): Promise<void> => {
      const service = walletServiceRef.current
      if (!service) return
      try {
        await Effect.runPromise(service.saveAssetRows(groupId as WalletGroupId, CARDANO_MAINNET, accountIndex, rows))
      } catch (e) {
        logger.warn('saveAssetsForWallet failed', {origin: 'WalletProvider', error: String(e)})
      }
    },
    [],
  )

  const listUtxosForWallet = useCallback(
    async (
      groupId: string,
      chainId: ChainId,
      options?: {readonly accountIndex?: number; readonly pureOnly?: boolean},
    ): Promise<readonly UtxoRow[]> => {
      const service = walletServiceRef.current
      if (!service) return []
      try {
        return await Effect.runPromise(
          service.listUtxos(
            groupId as WalletGroupId,
            chainId,
            options?.accountIndex,
            options?.pureOnly === true ? {pureOnly: true} : undefined,
          ),
        )
      } catch (e: unknown) {
        logger.warn('Stored UTxOs unreadable; reporting none, which is not the same as holding none', {
          origin: 'WalletProvider',
          groupId,
          chainId,
          accountIndex: options?.accountIndex,
          error: String(e),
        })
        return []
      }
    },
    [],
  )

  const listAddressesForWallet = useCallback(
    async (
      groupId: string,
      chainId: ChainId,
      options?: {
        readonly accountIndex?: number
        readonly branch?: 'external' | 'internal' | 'single'
        readonly isUsed?: boolean
      },
    ): Promise<readonly AddressRow[]> => {
      const service = walletServiceRef.current
      if (!service) return []
      try {
        const tableOptions: {branch?: 'external' | 'internal' | 'single'; isUsed?: boolean} = {}
        if (options?.branch !== undefined) tableOptions.branch = options.branch
        if (options?.isUsed !== undefined) tableOptions.isUsed = options.isUsed
        return await Effect.runPromise(
          service.listAddresses(
            groupId as WalletGroupId,
            chainId,
            options?.accountIndex,
            Object.keys(tableOptions).length === 0 ? undefined : tableOptions,
          ),
        )
      } catch (e: unknown) {
        // ⚠️ An empty list is how the Cardano rail decides it owns only its primary
        // address, so a failed read and a genuinely empty book produce the same
        // one-credential rail and the same wrong balance — the `credentials: 1`
        // outcome that means the address book never loaded.
        logger.warn('address rows unreadable; callers will see an empty address book', {
          origin: 'WalletProvider',
          groupId,
          chainId,
          accountIndex: options?.accountIndex,
          error: String(e),
        })
        return []
      }
    },
    [],
  )

  const listAddressesForChain = useCallback(async (chainId: ChainId): Promise<readonly AddressRow[]> => {
    const service = walletServiceRef.current
    if (!service) return []
    try {
      return await Effect.runPromise(service.listAddressesForChain(chainId))
    } catch (e: unknown) {
      logger.warn('Address book unreadable for this chain; reporting no addresses, which strands every wallet on it', {
        origin: 'WalletProvider',
        chainId,
        error: String(e),
      })
      return []
    }
  }, [])

  const cacheAccountXPub = useCallback(
    async (params: {
      groupId: string
      chainId: ChainId
      publicKey: Uint8Array
      chainCode: Uint8Array
      accountIndex?: number
    }): Promise<void> => {
      const walletService = walletServiceRef.current
      if (!walletService) {
        throw new WalletError({message: 'Wallet service not initialized'})
      }

      await Effect.runPromise(
        walletService.cacheAccountXPub({
          groupId: params.groupId as WalletGroupId,
          chainId: params.chainId,
          publicKey: params.publicKey,
          chainCode: params.chainCode,
          ...(params.accountIndex !== undefined ? {accountIndex: params.accountIndex} : {}),
        }),
      )
      await Effect.runPromise(walletService.save())
    },
    [],
  )

  const selectAccount = useCallback(
    async (chainId: ChainId, index: number) => {
      const walletService = walletServiceRef.current
      const sel = selectionRef.current
      if (!walletService || !sel) return

      logger.info('User switching account', {
        origin: 'WalletProvider',
        groupId: sel.groupId,
        chainId,
        accountIndex: index,
      })
      setIsLoading(true)
      setError(null)
      try {
        // Update selection to new account index. Chain is per-screen — the
        // caller passed it in; we don't store it on the global selection.
        const newSelection: WalletSelection = {groupId: sel.groupId, accountIndex: index}
        await Effect.runPromise(walletService.select(newSelection))

        // Update the chain config's selectedAccountIndex in the group
        await Effect.runPromise(
          Ref.update(walletService.walletManager.groups, (map) => {
            const next = new Map(map)
            const group = next.get(sel.groupId)
            if (group) {
              const chains = new Map(group.chains)
              const chainConfig = chains.get(chainId)
              if (chainConfig) {
                chains.set(chainId, {...chainConfig, selectedAccountIndex: index})
                next.set(sel.groupId, {...group, chains})
              }
            }
            return next
          }),
        )

        // Refresh React state so UI reflects the change immediately
        const updatedState = await Effect.runPromise(walletService.getState())
        updateFromServiceState(updatedState)

        await Effect.runPromise(walletService.save())
        // Re-sync to refresh addresses/balances for the new account
        await Effect.runPromise(walletService.sync())
        logger.info('Account switched', {origin: 'WalletProvider', groupId: sel.groupId, chainId, accountIndex: index})
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : 'Failed to switch account'
        logger.error(errorMessage, {origin: 'WalletProvider', cause: e})
        setError(errorMessage)
      } finally {
        setIsLoading(false)
      }
    },
    [updateFromServiceState],
  )

  const addAccount = useCallback(
    async (chainId: ChainId) => {
      const walletService = walletServiceRef.current
      const sel = selectionRef.current
      if (!walletService || !sel) return

      logger.info('User adding account', {origin: 'WalletProvider', groupId: sel.groupId, chainId})
      setIsLoading(true)
      setError(null)
      try {
        const state = await Effect.runPromise(walletService.getState())
        const group = state.groups.get(sel.groupId)
        if (!group) {
          logger.warn('addAccount: group not found', {origin: 'WalletProvider', groupId: sel.groupId})
          return
        }
        const chainConfig = group.chains.get(chainId)
        if (!chainConfig) {
          logger.warn('addAccount: chain not enabled on group', {
            origin: 'WalletProvider',
            groupId: sel.groupId,
            chainId,
            chains: [...group.chains.keys()],
          })
          return
        }

        // Deriving a new account needs the seed — mnemonic wallets only.
        // Hardware needs an on-device export (follow-up); watch-only has no seed.
        if (group.source !== 'mnemonic') {
          logger.warn('addAccount: unsupported source for derivation', {
            origin: 'WalletProvider',
            groupId: sel.groupId,
            source: group.source,
          })
          setError('Deriving accounts requires a software wallet')
          return
        }

        const newIndex = chainConfig.accounts.length

        // Derive + persist the new account's xpub BEFORE registering it, so its
        // address/rail resolve immediately (getXPub(…, newIndex) must succeed).
        // Retrieving the mnemonic is the one biometric gate; scanAccounts is
        // idempotent for the already-derived 0..newIndex-1 xpubs.
        const {createEnclaveMnemonicVault} = await import('../services/credential-vault')
        const mnemonic = await Effect.runPromise(
          createEnclaveMnemonicVault().retrieve(sel.groupId, biometricAuthPromptRef.current),
        )
        await Effect.runPromise(
          walletService.walletManager.scanAccounts(sel.groupId as WalletGroupId, chainId, mnemonic, newIndex + 1),
        )
        // The new account has its own DUST key, derived at its own index — so an account added after a
        // wallet was created would otherwise be the one account the scheduler could never sync. Same
        // prompt, already answered on the retrieve above.
        // Only for a Midnight account. Accounts are per chain, so adding a Cardano account at index 1
        // says nothing about a Midnight account at index 1 — seeding a key for it would be inventing an
        // account. `group.source !== 'mnemonic'` has already returned above, so this is a software
        // wallet by the time we are here.
        const fundsNetworkAtAdd = midnightFundsNetwork(network)
        if (fundsNetworkAtAdd !== null && isMidnightChainId(chainId)) {
          void rememberSyncKeysForScheduler(sel.groupId, newIndex, mnemonic, fundsNetworkAtAdd)
        }

        // scanAccounts already registered accounts 0..newIndex (with newIndex
        // disabled). Enable the new account + make it the selected one — do NOT
        // append (that would duplicate the index scanAccounts just added).
        await Effect.runPromise(
          Ref.update(walletService.walletManager.groups, (map) => {
            const next = new Map(map)
            const g = next.get(sel.groupId)
            if (g) {
              const chains = new Map(g.chains)
              const cc = chains.get(chainId)
              if (cc) {
                const enabled = cc.accounts.map((a) => (a.index === newIndex ? {...a, enabled: true} : a))
                const accounts = enabled.some((a) => a.index === newIndex)
                  ? enabled
                  : [...enabled, {index: newIndex, enabled: true}]
                chains.set(chainId, {...cc, accounts, selectedAccountIndex: newIndex})
                next.set(sel.groupId, {...g, chains})
              }
            }
            return next
          }),
        )

        // Update selection to new account
        const newSelection: WalletSelection = {groupId: sel.groupId, accountIndex: newIndex}
        await Effect.runPromise(walletService.select(newSelection))

        // Refresh React state so UI reflects the change immediately
        const updatedState = await Effect.runPromise(walletService.getState())
        updateFromServiceState(updatedState)

        await Effect.runPromise(walletService.save())
        await Effect.runPromise(walletService.sync())
        logger.info('Account added', {origin: 'WalletProvider', groupId: sel.groupId, chainId, accountIndex: newIndex})
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : 'Failed to add account'
        logger.error(errorMessage, {origin: 'WalletProvider', cause: e})
        setError(errorMessage)
      } finally {
        setIsLoading(false)
      }
    },
    [updateFromServiceState, network],
  )

  // ============================================================================
  // Memoized Context Values (each only changes when its specific data changes)
  // ============================================================================

  const coreValue = useMemo<WalletCoreContextValue>(
    () => ({isReady, isLoading, error, clearError}),
    [isReady, isLoading, error, clearError],
  )

  const listValue = useMemo<WalletListContextValue>(
    () => ({
      wallets: groupWallets,
      allWallets: walletsArray,
      walletGroups,
      selectedWalletGroup,
      accounts: [], // Will be populated in future phases
      selectedAccountIndex,
      accountCount,
      selectWallet,
      selectAllBlockchains,
      selectAccount,
      addAccount,
      createWallet,
      restoreWallet,
      createFromDevice,
      persistDeviceDeriveOnlyAddress,
      setDeviceXpubs,
      addDeviceAccount,
      createReadOnlyWallet,
      registerSharedWalletGroup,
      deleteWallet,
      deleteAllWalletData,
      renameWallet,
      cacheAccountXPub,
      enableChainForGroup,
      disableChainForGroup,
      scanAccountsFromXPubs: scanAccountsFromXPubsFn,
      enableAccount: enableAccountFn,
      disableAccount: disableAccountFn,
    }),
    [
      groupWallets,
      walletsArray,
      walletGroups,
      selectedWalletGroup,
      selectedAccountIndex,
      accountCount,
      selectWallet,
      selectAllBlockchains,
      selectAccount,
      addAccount,
      createWallet,
      restoreWallet,
      createFromDevice,
      persistDeviceDeriveOnlyAddress,
      setDeviceXpubs,
      addDeviceAccount,
      createReadOnlyWallet,
      registerSharedWalletGroup,
      deleteWallet,
      deleteAllWalletData,
      renameWallet,
      cacheAccountXPub,
      enableChainForGroup,
      disableChainForGroup,
      scanAccountsFromXPubsFn,
      enableAccountFn,
      disableAccountFn,
    ],
  )

  const balanceValue = useMemo<WalletBalanceContextValue>(
    () => ({balance, balancesByChain, getBalanceForChain, refreshBalance}),
    [balance, balancesByChain, getBalanceForChain, refreshBalance],
  )

  const syncValue = useMemo<WalletSyncContextValue>(
    () => ({isSyncing, chainSyncStates, syncWallet, syncWalletById, syncChain, boostChainSync}),
    [isSyncing, chainSyncStates, syncWallet, syncWalletById, syncChain, boostChainSync],
  )
  // Note: isSyncing is derived from chainSyncStates via useMemo, so it updates
  // whenever chainSyncStates changes — no separate dependency needed.

  const getDeriveOnlyAddressesFor = useCallback(
    async (groupId: string, accountIndex: number): Promise<Partial<DeriveOnlyAddresses>> => {
      const service = walletServiceRef.current
      if (!service) return {}
      return Effect.runPromise(service.getDeriveOnlyAddresses(groupId as WalletGroupId, accountIndex))
    },
    [],
  )

  const getDeriveOnlyAddresses = useCallback(
    async (accountIndex = 0): Promise<Partial<DeriveOnlyAddresses>> => {
      const groupId = activeGroupRef.current?.groupId
      if (!groupId) return {}
      return getDeriveOnlyAddressesFor(groupId, accountIndex)
    },
    [getDeriveOnlyAddressesFor],
  )

  const ensureMidnightReceiveAddresses = useCallback(
    async (params: {groupId: string; mnemonic: string; accountIndex?: number}): Promise<readonly string[]> => {
      const service = walletServiceRef.current
      if (!service) return []
      return Effect.runPromise(
        service.ensureMidnightReceiveAddresses({
          groupId: params.groupId as WalletGroupId,
          mnemonic: params.mnemonic,
          ...(params.accountIndex === undefined ? {} : {accountIndex: params.accountIndex}),
        }),
      )
    },
    [],
  )

  const discoverCardanoAddresses = useCallback(
    async (
      network: CardanoAddress.Network,
      probe: CardanoUsageProbe,
      accountIndex = 0,
      options?: CardanoDiscoveryOptions,
    ): Promise<readonly string[]> => {
      const service = walletServiceRef.current
      const groupId = activeGroupRef.current?.groupId
      if (!service || !groupId) return []
      return Effect.runPromise(
        service.discoverCardanoAddresses(groupId as WalletGroupId, network, probe, accountIndex, options),
      )
    },
    [],
  )

  const addressValue = useMemo<WalletAddressContextValue>(
    () => ({
      receiveAddresses,
      getReceiveAddress,
      getDeriveOnlyAddresses,
      getDeriveOnlyAddressesFor,
      ensureMidnightReceiveAddresses,
      discoverCardanoAddresses,
      getChangeAddress,
      getStakeAddress,
      getUsedAddresses,
      getUnusedAddresses,
      getUsedAddressesIndexed,
      getUnusedAddressesIndexed,
      getInternalAddressesIndexed,
    }),
    [
      receiveAddresses,
      getReceiveAddress,
      getDeriveOnlyAddresses,
      getDeriveOnlyAddressesFor,
      ensureMidnightReceiveAddresses,
      discoverCardanoAddresses,
      getChangeAddress,
      getStakeAddress,
      getUsedAddresses,
      getUnusedAddresses,
      getUsedAddressesIndexed,
      getUnusedAddressesIndexed,
      getInternalAddressesIndexed,
    ],
  )

  const dataValue = useMemo<WalletDataContextValue>(
    () => ({
      stakingInfo,
      getUtxos,
      getAccountXPub,
      getSnapshotForWallet,
      getTransactionForWallet,
      listTransactionRowsForWallet,
      getTokenMetadata,
      saveTokenMetadata,
      listAssetsForWallet,
      saveAssetsForWallet,
      listUtxosForWallet,
      listAddressesForWallet,
      listAddressesForChain,
    }),
    [
      stakingInfo,
      getUtxos,
      getAccountXPub,
      getSnapshotForWallet,
      getTransactionForWallet,
      listTransactionRowsForWallet,
      getTokenMetadata,
      saveTokenMetadata,
      listAssetsForWallet,
      saveAssetsForWallet,
      listUtxosForWallet,
      listAddressesForWallet,
      listAddressesForChain,
    ],
  )

  // ============================================================================
  // Render with Nested Providers
  // ============================================================================

  return (
    <WalletCoreContext.Provider value={coreValue}>
      <WalletListContext.Provider value={listValue}>
        <WalletBalanceContext.Provider value={balanceValue}>
          <WalletSyncContext.Provider value={syncValue}>
            <WalletAddressContext.Provider value={addressValue}>
              <WalletDataContext.Provider value={dataValue}>{children}</WalletDataContext.Provider>
            </WalletAddressContext.Provider>
          </WalletSyncContext.Provider>
        </WalletBalanceContext.Provider>
      </WalletListContext.Provider>
    </WalletCoreContext.Provider>
  )
}

// ============================================================================
// Specialized Hooks (for better performance)
// ============================================================================

/**
 * Hook to access core wallet state (loading, ready, errors).
 * Only re-renders when these specific values change.
 *
 * @throws Error if used outside of WalletProvider
 */
export function useWalletCore(): WalletCoreContextValue {
  const context = useContext(WalletCoreContext)
  if (!context) {
    throw new Error('useWalletCore must be used within a WalletProvider')
  }
  return context
}

/**
 * Hook to access wallet list and selection.
 * Only re-renders when wallets or selection changes.
 *
 * @throws Error if used outside of WalletProvider
 */
export function useWalletList(): WalletListContextValue {
  const context = useContext(WalletListContext)
  if (!context) {
    throw new Error('useWalletList must be used within a WalletProvider')
  }
  return context
}

/**
 * Hook to access balance data.
 * Only re-renders when balance changes.
 *
 * @throws Error if used outside of WalletProvider
 */
export function useWalletBalance(): WalletBalanceContextValue {
  const context = useContext(WalletBalanceContext)
  if (!context) {
    throw new Error('useWalletBalance must be used within a WalletProvider')
  }
  return context
}

/**
 * Hook to access sync state.
 * Only re-renders when sync status changes.
 *
 * @throws Error if used outside of WalletProvider
 */
export function useWalletSync(): WalletSyncContextValue {
  const context = useContext(WalletSyncContext)
  if (!context) {
    throw new Error('useWalletSync must be used within a WalletProvider')
  }
  return context
}

/**
 * Hook to access address data and methods.
 * Only re-renders when addresses change.
 *
 * @throws Error if used outside of WalletProvider
 */
export function useWalletAddress(): WalletAddressContextValue {
  const context = useContext(WalletAddressContext)
  if (!context) {
    throw new Error('useWalletAddress must be used within a WalletProvider')
  }
  return context
}

/**
 * Hook to access additional wallet data (staking, UTxOs, transactions).
 * Only re-renders when this data changes.
 *
 * @throws Error if used outside of WalletProvider
 */
export function useWalletData(): WalletDataContextValue {
  const context = useContext(WalletDataContext)
  if (!context) {
    throw new Error('useWalletData must be used within a WalletProvider')
  }
  return context
}
