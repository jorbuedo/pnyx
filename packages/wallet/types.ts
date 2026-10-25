/**
 * Core wallet types and interfaces.
 *
 * @module
 */

import type {ChainId as ChainIdType} from '@pnyx/config'
import type {Mnemonic} from '@pnyx/crypto'
import type {Storage} from '@pnyx/storage'

/** Local branded string type. */
type BrandedString<T extends string> = string & {readonly __brand: T}

import type {UTxO} from '@evolution-sdk/evolution'
import {Context, type Effect, type Ref} from 'effect'

/**
 * Re-export ChainId from config package for convenience.
 */
export type ChainId = ChainIdType

/**
 * Wallet group identifier — the primary key for a user's "wallet".
 * One seed phrase or hardware device = one WalletGroupId.
 */
export type WalletGroupId = BrandedString<'WalletGroupId'>

/**
 * Composite reference to a specific chain within a group.
 */
export type WalletRef = {
  readonly groupId: WalletGroupId
  readonly chainId: ChainId
}

/**
 * Current user selection state — separate from wallet data.
 *
 * Only the wallet group and the active account index are global. Chain is
 * always a per-screen filter (route param, pill picker, carousel page) — never
 * a global default. Service operations that need a chain receive it as a
 * parameter; reading "the selected chain" from app-global state is a smell
 * that historically caused cross-chain leaks (a tx broadcast on Ethereum
 * persisted to the Cardano partition because Cardano happened to be the
 * last-tapped chain).
 */
export type WalletSelection = {
  readonly groupId: WalletGroupId
  readonly accountIndex: number
}

/**
 * Account identifier - unique string for each account.
 */
export type AccountId = BrandedString<'AccountId'>

/**
 * Global network mode. Named after the Cardano networks because Cardano is the
 * funds chain; every other chain maps this to its own name (Midnight collapses
 * both testnets to `testnet`, EVM would map to Sepolia).
 */
export type Network = 'mainnet' | 'preprod' | 'preview'

/** The networks that are not mainnet — no prices, no swap, test funds only. */
export const TESTNET_NETWORKS: readonly Network[] = ['preprod', 'preview']

/**
 * How a wallet derives its addresses.
 *
 * `cip1854` is a shared (multisig) wallet: addresses come from a native-script
 * template over its co-signers' account keys, not from this wallet's own
 * derivation. Deliberately not `readOnly` — a shared wallet can receive, and can
 * spend once its quorum signs, so the affordances that check for `readOnly`
 * must not disable it.
 */
export type WalletImplementation = 'cip1852' | 'bip44' | 'readOnly' | 'cip1854'

/**
 * Generic address type for multi-chain support.
 * Each chain encodes addresses differently (Bech32, Base58, hex, etc.)
 */
export type Address = string

/**
 * Vendor/model identifier for an external signing device (when a wallet
 * group was created from device-provided xpubs rather than a local seed).
 */
export type HardwareDeviceType = string

/**
 * Visual wallet checksum for identification.
 */
export type WalletChecksum = {
  /** Human-readable plate text, e.g. "ABCD-1234" */
  readonly plate: string
  /** Hex string seed for identicon generation */
  readonly seed: string
}

/**
 * Visual profile for a wallet — color + icon assigned at creation time.
 *
 * `iconStyle` selects the identicon engine when the avatar is rendered as an
 * identicon (e.g. {@link WalletIdenticon}). When omitted, callers fall back to
 * `'jazzicon'` to preserve the existing render. Wallets imported from the
 * legacy wallet pin `'blockies'` for visual continuity.
 *
 */
export type WalletProfile = {
  /** Identicon engine to use. Defaults to 'jazzicon' when omitted. */
  readonly iconStyle?: 'jazzicon' | 'blockies'
  /**
   * Optional seed override for the identicon engine. When omitted, the
   * checksum seed is used. Imported wallets may pin the wallet's xpub
   * here so Blockies renders a stable image across imports.
   */
  readonly iconSeed?: string
}

/**
 * How the wallet was originally created.
 *
 * `imported-xpriv` — a wallet restored from an encrypted-backup (CIP-0301)
 * `cardano-root` payload: the root/master extended private key, no recovery
 * phrase. **Nothing produces one yet.** `restore-from-backup.tsx` blocks
 * `cardano-root` up front because the enclave vault stores mnemonics only, so
 * this member is currently unreachable and `signerKindOf` answers `null` for it.
 * An earlier version of this comment claimed it "signs from the stored root
 * xpriv (pnyx-v1 storage)" — there is no such storage; the phrase appeared
 * nowhere but here.
 *
 * `multisig` — a CIP-1854 shared wallet. Holds no key of its own: it is spent by
 * a native script over its co-signers' keys, so it cannot sign alone. Route
 * every decision about it through `signerKindOf` / `spendingAuthorityOf` rather
 * than comparing against this member, so a new source cannot silently fall into
 * the key-signing path.
 */
export type WalletSource = 'mnemonic' | 'hardware' | 'read-only' | 'imported-xpriv' | 'multisig'

/**
 * A single account within a chain wallet.
 *
 * Accounts correspond to BIP-44 account indices (m/purpose'/coinType'/account').
 * Account 0 is always present and enabled. Additional accounts (1-19) are
 * discovered via "Scan for Accounts" and start disabled until the user enables them.
 */
export type AccountEntry = {
  /** BIP-44 account index (0-based). */
  readonly index: number
  /** Whether this account syncs in the background. Account 0 is always enabled. */
  readonly enabled: boolean
}

/**
 * Per-chain configuration within a wallet group.
 */
export type ChainConfig = {
  readonly implementation: WalletImplementation
  /** Accounts within this chain. At minimum [{index: 0, enabled: true}]. */
  readonly accounts: readonly AccountEntry[]
  /** Currently active account index in the UI. */
  readonly selectedAccountIndex: number
  /** Last time this chain was synced. */
  readonly lastSyncedAt?: Date
  /**
   * Addresses this wallet holds that no key of ours derives — a shared wallet's
   * compiled script address, a watch-only import.
   *
   * ⚠️ **The only durable copy.** An HD wallet's address book is rebuildable from
   * its xpub at any time, so the address table is a cache for it. For these two
   * kinds it was the *source*: written once at creation and never again, while the
   * table drops and recreates itself on a schema-version mismatch. That would have
   * left a shared or watch-only wallet with no Cardano address at all — receive and
   * the co-sign screen both resolve theirs from storage.
   *
   * Kept here so those rows can be written back. Absent for wallets whose addresses
   * are derived, which is every ordinary one.
   */
  readonly nonDerivedAddresses?: readonly string[]
}

/**
 * A wallet group — the primary stored entity.
 *
 * Represents one seed phrase or hardware device. Contains per-chain
 * configuration in the `chains` map. Group-level fields (name, source,
 * checksum) are stored once, not duplicated per chain.
 */
export type WalletGroup = {
  readonly groupId: WalletGroupId
  readonly name: string
  readonly createdAt: Date
  /** How the wallet was originally created. */
  readonly source: WalletSource
  /** Whether this wallet is backed by a hardware device. */
  readonly isHardware?: boolean
  /** Hardware device type (if isHardware is true). */
  readonly hardwareDeviceType?: HardwareDeviceType
  /** Visual wallet checksum (plate text + identicon seed). */
  readonly checksum?: WalletChecksum
  /** Visual profile (color + icon) assigned at creation time. */
  readonly profile?: WalletProfile
  /** Per-chain configuration. Key = ChainId, value = chain-specific config. */
  readonly chains: ReadonlyMap<ChainId, ChainConfig>
}

/**
 * A chain wallet — one blockchain within a wallet group.
 *
 * Read-only view derived from WalletGroup + ChainId via `toChainWallet()`.
 * This is the primary type that UI screens and components work with,
 * representing "the wallet I'm looking at right now".
 */
export type ChainWallet = {
  readonly groupId: WalletGroupId
  readonly chainId: ChainId
  readonly name: string
  readonly implementation: WalletImplementation
  readonly createdAt: Date
  readonly lastSyncedAt?: Date
  readonly isHardware?: boolean
  readonly hardwareDeviceType?: HardwareDeviceType
  readonly checksum?: WalletChecksum
  readonly profile?: WalletProfile
  readonly accounts: readonly AccountEntry[]
  readonly selectedAccountIndex: number
  readonly source: WalletSource
}

/**
 * Derive a ChainWallet view from a WalletGroup for a specific chain.
 * Returns undefined if the chain is not enabled in the group.
 */
export const toChainWallet = (group: WalletGroup, chainId: ChainId): ChainWallet | undefined => {
  const chain = group.chains.get(chainId)
  if (!chain) return undefined
  return {
    groupId: group.groupId,
    chainId,
    name: group.name,
    implementation: chain.implementation,
    createdAt: group.createdAt,
    ...(chain.lastSyncedAt ? {lastSyncedAt: chain.lastSyncedAt} : {}),
    ...(group.isHardware ? {isHardware: group.isHardware} : {}),
    ...(group.hardwareDeviceType ? {hardwareDeviceType: group.hardwareDeviceType} : {}),
    ...(group.checksum ? {checksum: group.checksum} : {}),
    ...(group.profile ? {profile: group.profile} : {}),
    accounts: chain.accounts,
    selectedAccountIndex: chain.selectedAccountIndex,
    source: group.source,
  }
}

/**
 * Address chain for BIP44 discovery.
 */
export type AddressChain = {
  readonly role: 0 | 1 // 0 = external, 1 = internal (change)
  readonly addresses: readonly Address[]
  readonly lastUsedIndex: number
  readonly gapLimit: number
}

/**
 * Account with address chains.
 */
export type Account = {
  readonly id: AccountId
  readonly groupId: WalletGroupId
  readonly chainId: ChainId
  readonly index: number
  readonly name: string
  readonly publicKey: Uint8Array
  readonly externalChain: AddressChain
  readonly internalChain: AddressChain
  readonly rewardAddress: string
}

/**
 * Transaction direction classification.
 */
export type TransactionDirection = 'sent' | 'received' | 'self' | 'multi'

/**
 * Transaction status.
 */
export type TransactionStatus = 'pending' | 'confirmed' | 'failed'

/**
 * Transaction input from wallet perspective.
 */
export type WalletTransactionInput = {
  readonly txHash: string
  readonly txIndex: number
  readonly address: string
  readonly value: {
    readonly lovelace: bigint
    readonly assets?: ReadonlyMap<string, bigint>
  }
}

/**
 * Transaction output from wallet perspective.
 */
export type WalletTransactionOutput = {
  readonly address: string
  readonly value: {
    readonly lovelace: bigint
    readonly assets?: ReadonlyMap<string, bigint>
  }
}

/**
 * Transaction with wallet context.
 */
export type WalletTransaction = {
  readonly hash: string
  readonly block?: {
    readonly hash: string
    readonly height: number
    readonly slot: number
    readonly time: Date
  }
  readonly inputs: readonly WalletTransactionInput[]
  readonly outputs: readonly WalletTransactionOutput[]
  readonly fee: bigint
  readonly certificates: readonly unknown[]
  readonly withdrawals: readonly unknown[]
  readonly metadata?: unknown
  readonly validContract: boolean
}

/**
 * Transaction summary with classification.
 */
export type TransactionSummary = {
  readonly hash: string
  readonly direction: TransactionDirection
  readonly status: TransactionStatus
  readonly timestamp?: Date
  readonly confirmations: number | null
  readonly amount: {
    readonly lovelace: bigint
    readonly assets: ReadonlyMap<string, bigint>
  }
  readonly fee: bigint
  readonly ownInputs: readonly WalletTransactionInput[]
  readonly ownOutputs: readonly WalletTransactionOutput[]
}

/** Transaction fetch mode: 'recent' fetches only the last few transactions, 'all' fetches everything. */
export type TxFetchMode = 'recent' | 'all'

/** Transaction fetch mode constants. */
export const TX_FETCH_MODE = {
  RECENT: 'recent' as const,
  ALL: 'all' as const,
} as const

/**
 * Sync state for a wallet.
 */
export type SyncState = 'idle' | 'syncing' | 'paused' | 'error'

/**
 * Wallet sync state.
 */
export type WalletSyncState = {
  readonly groupId: WalletGroupId
  readonly state: SyncState
  readonly lastSynced?: Date
  readonly lastError?: string
  readonly progress?: number
}

/**
 * Sync configuration.
 */
export type SyncConfig = {
  readonly concurrency: number
  readonly staggerMs: number
  readonly backoff: {
    readonly initial: number
    readonly max: number
    readonly multiplier: number
  }
  readonly prioritization: 'lastSelected' | 'oldest' | 'none'
}

/**
 * Parameters for creating wallet from mnemonic.
 */
export type CreateFromMnemonicParams = {
  readonly name: string
  /**
   * Deliberately a plain `string`, not the `Mnemonic` brand: this is the phrase the user just
   * typed or the app just generated, *before* it has been through the vault. The brand asserts
   * vault provenance, which this value does not have yet — same reason `vault.store` is unbranded.
   */
  readonly mnemonic: string
  readonly chainId: ChainId
  readonly implementation?: WalletImplementation
  /** Group ID to link wallets from the same mnemonic. Auto-generated if not provided. */
  readonly groupId?: WalletGroupId
  /** How the wallet was originally created (defaults to 'mnemonic'). */
  readonly source?: WalletSource
}

/**
 * Parameters for creating wallet from extended public key.
 */
export type CreateFromXPubParams = {
  readonly name: string
  readonly publicKey: Uint8Array
  readonly chainCode: Uint8Array
  readonly chainId: ChainId
  /** How the wallet was originally created. */
  readonly source?: WalletSource
  /** Whether this is a hardware wallet */
  readonly isHardware?: boolean
  /** Hardware device type (if isHardware is true) */
  readonly hardwareDeviceType?: HardwareDeviceType
  /** Group ID to link wallets from the same device. Auto-generated if not provided. */
  readonly groupId?: WalletGroupId
}

/**
 * Parameters for caching a pre-derived account-level extended public key (BIP-44 account, account-level xpub)
 * without enabling the chain on the wallet group.
 */
export type CacheAccountXPubParams = {
  readonly groupId: WalletGroupId
  readonly chainId: ChainId
  readonly publicKey: Uint8Array
  readonly chainCode: Uint8Array
  readonly accountIndex?: number
}

/**
 * Parameters for creating wallet from hardware device with multiple account xpubs.
 */
export type CreateFromDeviceParams = {
  readonly name: string
  /**
   * The account xpubs to import (publicKey + chainCode), each naming the device
   * account index it was derived at.
   *
   * `accountIndex` is stated rather than taken from the array position. The
   * position was the account number until 2026-08-15, which silently filed a
   * device's account 2 under group slot 0 whenever the user picked anything but
   * the first row — and every signing path derives from the slot, so the group's
   * addresses came from one key while its witnesses came from another.
   */
  readonly publicKeys: readonly {
    readonly publicKey: Uint8Array
    readonly chainCode: Uint8Array
    readonly accountIndex: number
  }[]
  readonly chainId: ChainId
  readonly deviceType: HardwareDeviceType
  /** How the wallet was originally created (defaults to 'hardware'). */
  readonly source?: WalletSource
  /** Group ID to link wallets from the same device. Auto-generated if not provided. */
  readonly groupId?: WalletGroupId
}

/**
 * Parameters for creating read-only wallet.
 */
export type CreateReadOnlyParams = {
  readonly name: string
  readonly addresses: readonly string[]
  readonly chainId: ChainId
  /** How the wallet was originally created (defaults to 'read-only'). */
  readonly source?: WalletSource
  /** Group ID to make creation idempotent (dedupe re-adds). Auto-generated if absent. */
  readonly groupId?: WalletGroupId
  /** Hex seed for the wallet checksum + identicon (read-only wallets have no xpub;
   *  the stake key hash is a stable per-account seed). */
  readonly checksumSeed?: string
}

/**
 * Pagination parameters.
 */
export type Pagination = {
  readonly offset: number
  readonly limit: number
}

/**
 * Single balance entry (id + quantity as bigint). Mirrors StoredBalance with quantity as bigint.
 */
export type WalletBalanceEntry = {
  readonly id: string
  readonly quantity: bigint
}

/**
 * Balance result. Shape mirrors StoredBalances (primary = native for chain, secondary = other assets).
 */
export type WalletBalance = {
  readonly primary: WalletBalanceEntry
  readonly secondary: readonly WalletBalanceEntry[]
}

// ============================================================================
// Service Tags
// ============================================================================

/**
 * WalletManager service for multi-wallet management.
 *
 * The primary entity is WalletGroup (one per seed/device). Chain wallets
 * are entries in the group's `chains` map. All methods address wallets
 * via `groupId` or `groupId + chainId`.
 */
export type WalletManager = {
  /** All wallet groups, keyed by groupId. */
  readonly groups: Ref.Ref<ReadonlyMap<WalletGroupId, WalletGroup>>
  /** Current user selection (group + chain + account). */
  readonly selection: Ref.Ref<WalletSelection | null>

  // === Creation ===

  readonly createFromMnemonic: (
    params: CreateFromMnemonicParams,
  ) => Effect.Effect<WalletGroup, import('./errors.js').WalletCreationError>
  readonly createFromXPub: (
    params: CreateFromXPubParams,
  ) => Effect.Effect<WalletGroup, import('./errors.js').WalletCreationError>
  readonly cacheAccountXPub: (
    params: CacheAccountXPubParams,
  ) => Effect.Effect<void, import('./errors.js').WalletCreationError>
  readonly createReadOnly: (
    params: CreateReadOnlyParams,
  ) => Effect.Effect<WalletGroup, import('./errors.js').WalletCreationError>
  readonly createFromDevice: (
    params: CreateFromDeviceParams,
  ) => Effect.Effect<WalletGroup, import('./errors.js').WalletCreationError>

  // === Queries ===

  readonly getGroup: (groupId: WalletGroupId) => Effect.Effect<WalletGroup, import('./errors.js').WalletNotFoundError>
  readonly getChainConfig: (
    groupId: WalletGroupId,
    chainId: ChainId,
  ) => Effect.Effect<ChainConfig, import('./errors.js').WalletNotFoundError>
  /** Get xpub by (groupId, chainId, accountIndex). */
  readonly getXPub: (
    groupId: WalletGroupId,
    chainId: ChainId,
    accountIndex: number,
  ) => Effect.Effect<Uint8Array, import('./errors.js').WalletNotFoundError>

  /**
   * Derive + persist any missing account-0 xpub for the group's configured and
   * derive-only chains (BTC/EVM/ADA) from `mnemonic`. Idempotent per chain and
   * skips chains that can't derive (Solana). Returns the chains newly added.
   * Public material only; call inside an open ceremony (seed available).
   */
  readonly ensureAccountXpubs: (
    groupId: WalletGroupId,
    /**
     * Plain `string`, not `Mnemonic`. The doc above says "inside an open ceremony", but the live
     * caller is the *import* path (`wallet-service.ts`), which passes the phrase the user just
     * typed — before it has ever been stored. So this value legitimately has no vault provenance,
     * and branding it would only be satisfiable by laundering an unbranded value through
     * `asMnemonic`, which is worse than leaving it honest.
     */
    mnemonic: string,
  ) => Effect.Effect<readonly ChainId[], import('./errors.js').WalletCreationError>

  /** Store hardware-device account xpubs for derive-only chains (no chain
   *  registration) at `accountIndex`. See the wallet-manager impl for rationale. */
  readonly setDeviceAccountXpubs: (
    groupId: WalletGroupId,
    entries: readonly {readonly chainId: ChainId; readonly publicKey: Uint8Array; readonly chainCode: Uint8Array}[],
    accountIndex?: number,
  ) => Effect.Effect<readonly ChainId[], never>

  /** Add a device-derived account at `accountIndex` to an existing hardware
   *  group (xpub + register/enable + select). Hardware "add account" flow. */
  readonly addDeviceAccount: (
    groupId: WalletGroupId,
    chainId: ChainId,
    accountIndex: number,
    key: {readonly publicKey: Uint8Array; readonly chainCode: Uint8Array},
  ) => Effect.Effect<WalletGroup, import('./errors.js').WalletNotFoundError>

  // === Selection ===

  readonly select: (selection: WalletSelection) => Effect.Effect<void, import('./errors.js').WalletNotFoundError>
  readonly deselect: () => Effect.Effect<void, never>

  // === Mutation ===

  readonly deleteGroup: (groupId: WalletGroupId) => Effect.Effect<void, import('./errors.js').WalletNotFoundError>

  /** Update the source of a wallet group (e.g., upgrade from 'imported-xpriv' to 'mnemonic'). */
  readonly updateSource: (
    groupId: WalletGroupId,
    source: WalletSource,
  ) => Effect.Effect<WalletGroup, import('./errors.js').WalletNotFoundError>

  /**
   * Enable a new chain for an existing wallet group.
   *
   * Fast path uses pre-derived xpub when available. Slow path (no
   * cached xpub) requires a pre-decrypted mnemonic in `opts.mnemonic`
   * — the WalletProvider retrieves it via the enclave vault (OS
   * biometric / device-passcode prompt) before calling in.
   */
  readonly enableChain: (
    groupId: WalletGroupId,
    chainId: ChainId,
    opts?: {readonly mnemonic?: string},
  ) => Effect.Effect<WalletGroup, import('./errors.js').WalletCreationError | import('./errors.js').StorageError>
  /** Disable a chain (removes it from the group's chains map). */
  readonly disableChain: (
    groupId: WalletGroupId,
    chainId: ChainId,
  ) => Effect.Effect<WalletGroup, import('./errors.js').WalletNotFoundError>

  // === Account scanning ===

  /** Derive xpubs for accounts 0..(count-1), store them, and populate the accounts array. */
  readonly scanAccounts: (
    groupId: WalletGroupId,
    chainId: ChainId,
    mnemonic: Mnemonic,
    count?: number,
  ) => Effect.Effect<ChainConfig, import('./errors.js').WalletCreationError | import('./errors.js').WalletNotFoundError>

  /** Store pre-derived xpubs (from hardware device) and populate the accounts array. */
  readonly scanAccountsFromXPubs: (
    groupId: WalletGroupId,
    chainId: ChainId,
    xpubs: ReadonlyArray<{readonly index: number; readonly xpub: Uint8Array}>,
  ) => Effect.Effect<ChainConfig, import('./errors.js').WalletNotFoundError>

  /** Enable a discovered account so it syncs in the background. */
  readonly enableAccount: (
    groupId: WalletGroupId,
    chainId: ChainId,
    accountIndex: number,
  ) => Effect.Effect<ChainConfig, import('./errors.js').WalletNotFoundError>

  /** Disable an account (stops syncing). Cannot disable account 0. */
  readonly disableAccount: (
    groupId: WalletGroupId,
    chainId: ChainId,
    accountIndex: number,
  ) => Effect.Effect<ChainConfig, import('./errors.js').WalletNotFoundError>

  // === Checksum ===

  /**
   * Compute and attach a CIP-4 checksum to a group if missing.
   * Prefers Cardano account 0 xpub, falls back to Ethereum, then any available chain.
   * Returns the checksum seed (for downstream profile derivation), or undefined if no xpub is available.
   */
  readonly attachChecksum: (
    groupId: WalletGroupId,
  ) => Effect.Effect<WalletChecksum | undefined, import('./errors.js').WalletNotFoundError>

  // === Persistence ===

  readonly save: () => Effect.Effect<void, import('./errors.js').StorageError, Storage>
  readonly load: () => Effect.Effect<void, import('./errors.js').StorageError, Storage>
}

export const WalletManager = Context.GenericTag<WalletManager>('WalletManager')

/**
 * The confirmed-UTxO set.
 *
 * ⚠️ Evolution's `UTxO` is the type (2026-10-11), so a set held here needs no conversion before a
 * plan build.
 *
 * ⚠️ **Five members went with that change rather than being retyped, because none had a caller**:
 * `getBalance` (the rail sums its own, over the spendable view this does not know about),
 * `getCollateral` / `setCollateral` (no collateral flow exists), and `syncDiff` with the
 * `utxo-diff` machinery behind it — every sync is a full refetch, which is the rail's
 * reconciliation contract. Porting them would have been porting dead code to a new type.
 */
export type UtxoManager = {
  readonly utxos: Ref.Ref<ReadonlyMap<string, UTxO.UTxO>>
  readonly getUtxos: () => Effect.Effect<readonly UTxO.UTxO[], never>
  readonly syncFull: (addresses: readonly string[]) => Effect.Effect<void, import('./errors.js').SyncError>
}

export const UtxoManager = Context.GenericTag<UtxoManager>('UtxoManager')

/**
 * SyncManager service for sync orchestration.
 */
export type SyncManager = {
  readonly state: Ref.Ref<SyncState>
  readonly walletStates: Ref.Ref<ReadonlyMap<WalletGroupId, WalletSyncState>>

  readonly start: () => Effect.Effect<void, never>
  readonly stop: () => Effect.Effect<void, never>
  readonly pause: () => Effect.Effect<void, never>
  readonly resume: () => Effect.Effect<void, never>

  readonly syncWallet: (groupId: WalletGroupId) => Effect.Effect<void, import('./errors.js').SyncError>
  readonly syncAll: () => Effect.Effect<ReadonlyMap<WalletGroupId, import('./errors.js').SyncError | null>, never>

  readonly onTransactionSubmitted: (tx: WalletTransaction) => Effect.Effect<void, never>
}

export const SyncManager = Context.GenericTag<SyncManager>('SyncManager')

export type Powers = {
  readonly staking: DerivativeInfo
  /**
   * DRep (governance) key. Absent for read-only-by-address wallets, whose DRep
   * key (CIP-1852 role 3) can't be derived without the account xpub. Only
   * needed to sign governance certificates — vote-delegation *display* comes
   * from the snapshot's `delegated.voting`, populated from stake-key state.
   */
  readonly governance?: DerivativeInfo
  readonly ccCold?: DerivativeInfo
  readonly ccHot?: DerivativeInfo
}
export type DerivativeInfo = {
  readonly index: number
  readonly hash: string
  readonly human: string
  readonly pubKeyHex: string
}
