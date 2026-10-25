/**
 * Multi-wallet management.
 *
 * Primary entity is WalletGroup (one per seed/device). Chain wallets are
 * entries in the group's `chains` map. All operations address wallets via
 * groupId or groupId + chainId.
 *
 * @module
 */

import {BITCOIN_MAINNET, CARDANO_MAINNET, ETHEREUM_MAINNET, getChainNamespace, MIDNIGHT_MAINNET} from '@pnyx/config'
import {HDKey, hex, secp256k1AccountXpub} from '@pnyx/crypto'
import {walletChecksum} from '@pnyx/identicon'
import {createLogger, type Logger} from '@pnyx/logger'
import {deriveSecp256k1Key} from '@pnyx/signer/chains'
import {Storage} from '@pnyx/storage'
import {Effect, Either, Layer, Option, Ref} from 'effect'
import {DerivationError, StorageError, WalletCreationError, WalletNotFoundError} from '../errors.js'
import type {WalletDataStore} from '../store/wallet-data-store.js'
import type {ChainId, WalletProfile} from '../types.js'
import {
  type AccountEntry,
  type CacheAccountXPubParams,
  type ChainConfig,
  type CreateFromDeviceParams,
  type CreateFromMnemonicParams,
  type CreateFromXPubParams,
  type CreateReadOnlyParams,
  type WalletChecksum,
  type WalletGroup,
  type WalletGroupId,
  WalletManager,
  type WalletSelection,
  type WalletSource,
} from '../types.js'
import {deriveCardanoAccountXpub} from './derivation/cardano.js'
import {getChainFamily, getDerivationConfig} from './derivation-config.js'
import {mnemonicToSeed} from './seed.js'
import {createXPubStore} from './xpub-store.js'

// New storage keys (WalletGroup model)
const STORAGE_KEY = '@pnyx/wallet/groups'
const SELECTED_KEY = '@pnyx/wallet/selection'
const XPUB_STORE_KEY = '@pnyx/wallet/xpubs'

const cryptoRandomHex = (): string => {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return hex.encode(bytes)
}

export const generateGroupId = (): WalletGroupId => `group-${cryptoRandomHex()}` as WalletGroupId

// ============================================================================
// Serialization
// ============================================================================

type SerializedChainConfig = {
  readonly implementation: string
  readonly accounts: readonly {readonly index: number; readonly enabled: boolean}[]
  readonly selectedAccountIndex: number
  readonly lastSyncedAt?: string
  readonly nonDerivedAddresses?: readonly string[]
}

type SerializedWalletGroup = {
  readonly groupId: string
  readonly name: string
  readonly createdAt: string
  readonly source?: WalletSource
  readonly isHardware?: boolean
  readonly hardwareDeviceType?: string
  readonly checksum?: WalletChecksum
  readonly profile?: WalletProfile
  readonly chains: Record<string, SerializedChainConfig>
}

const serializeGroup = (group: WalletGroup): SerializedWalletGroup => {
  const chains: Record<string, SerializedChainConfig> = {}
  for (const [chainId, config] of group.chains) {
    chains[chainId] = {
      implementation: config.implementation,
      accounts: config.accounts,
      selectedAccountIndex: config.selectedAccountIndex,
      ...(config.lastSyncedAt ? {lastSyncedAt: config.lastSyncedAt.toISOString()} : {}),
      ...(config.nonDerivedAddresses && config.nonDerivedAddresses.length > 0
        ? {nonDerivedAddresses: config.nonDerivedAddresses}
        : {}),
    }
  }
  return {
    groupId: group.groupId,
    name: group.name,
    createdAt: group.createdAt.toISOString(),
    source: group.source,
    ...(group.isHardware ? {isHardware: group.isHardware} : {}),
    ...(group.hardwareDeviceType ? {hardwareDeviceType: group.hardwareDeviceType} : {}),
    ...(group.checksum ? {checksum: group.checksum} : {}),
    ...(group.profile ? {profile: group.profile} : {}),
    chains,
  }
}

const deserializeGroup = (data: SerializedWalletGroup): WalletGroup => {
  const chains = new Map<ChainId, ChainConfig>()
  for (const [chainId, config] of Object.entries(data.chains)) {
    chains.set(chainId as ChainId, {
      implementation: config.implementation as ChainConfig['implementation'],
      accounts: config.accounts.length > 0 ? config.accounts : [{index: 0, enabled: true}],
      selectedAccountIndex: config.selectedAccountIndex,
      ...(config.lastSyncedAt ? {lastSyncedAt: new Date(config.lastSyncedAt)} : {}),
      ...(config.nonDerivedAddresses && config.nonDerivedAddresses.length > 0
        ? {nonDerivedAddresses: config.nonDerivedAddresses}
        : {}),
    })
  }
  const group: WalletGroup = {
    groupId: data.groupId as WalletGroupId,
    name: data.name,
    createdAt: new Date(data.createdAt),
    source: data.source ?? (data.isHardware ? 'hardware' : 'mnemonic'),
    chains,
  }
  if (data.isHardware) (group as {isHardware: boolean}).isHardware = data.isHardware
  if (data.hardwareDeviceType) (group as {hardwareDeviceType: string}).hardwareDeviceType = data.hardwareDeviceType
  if (data.checksum) (group as {checksum: WalletChecksum}).checksum = data.checksum
  if (data.profile) (group as {profile: WalletProfile}).profile = data.profile
  return group
}

// ============================================================================
// WalletManager configuration
// ============================================================================

export type WalletManagerConfig = {
  readonly walletStore?: WalletDataStore
  /** All chain IDs to pre-derive xpubs for at creation time. */
  readonly allChainIds?: readonly ChainId[]
  /** Logger instance for timing and debug output. */
  readonly logger?: Logger
}

// ============================================================================
// Key derivation
// ============================================================================

/** Resolve the chain family as a typed failure instead of a thrown defect. */
const chainFamilyFor = (chainId: ChainId): Effect.Effect<ReturnType<typeof getChainFamily>, WalletCreationError> =>
  Effect.try({
    try: () => getChainFamily(chainId),
    catch: (e) => new WalletCreationError({message: `Unsupported chain: ${String(e)}`, cause: e}),
  })

/** Resolve the wallet implementation for a chain as a typed failure instead of a thrown defect. */
const implementationFor = (chainId: ChainId): Effect.Effect<'cip1852' | 'bip44', WalletCreationError> =>
  Effect.try({
    try: () => (getDerivationConfig(chainId).standard === 'cip1852' ? ('cip1852' as const) : ('bip44' as const)),
    catch: (e) => new WalletCreationError({message: `Unsupported chain: ${String(e)}`, cause: e}),
  })

/**
 * Chains that get a derive-only account xpub persisted at import, keyed by CAIP-2
 * namespace: Bitcoin (BIP-84 `m/84'/0'`), EVM (BIP-44 `m/44'/60'`), and Cardano
 * (CIP-1852 `m/1852'/1815'`). Solana is intentionally absent — SLIP-0010 ed25519
 * has no public-child (CKDpub) derivation, so an account xpub cannot seed
 * seedless address discovery and is not persistable.
 */
const DERIVE_ONLY_XPUB_CHAIN_IDS: readonly ChainId[] = [BITCOIN_MAINNET, ETHEREUM_MAINNET, CARDANO_MAINNET]

/**
 * Chain namespaces that have an account-level xpub (see {@link deriveAccountXPub}).
 * A chain outside this set (Solana SLIP-0010, unknown namespaces) has no
 * persistable account xpub and is skipped explicitly — never by swallowing a
 * derivation error.
 */
const ACCOUNT_XPUB_NAMESPACES: ReadonlySet<string> = new Set(['midnight', 'bip122', 'eip155', 'cardano'])

const causeMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/**
 * Midnight account xpub: BIP-39 seed (empty passphrase) → secp256k1 BIP-32 at
 * m/44'/2400'/account'. Stored as 33-byte compressed pubkey ‖ 32-byte chain code
 * (65 bytes), matching the layout `createFromXPub`/`cacheAccountXPub` persist.
 */
const midnightAccountXpub = (
  mnemonic: string,
  chainId: ChainId,
  accountIndex: number,
): Effect.Effect<Uint8Array, WalletCreationError> =>
  Effect.gen(function* () {
    const derivationConfig = getDerivationConfig(chainId)
    const path = `m/${derivationConfig.purpose}'/${derivationConfig.coinType}'/${accountIndex}'`

    const accountKey = yield* deriveSecp256k1Key(mnemonic, path, chainId).pipe(
      Effect.mapError(
        (e) => new WalletCreationError({message: `Failed to derive account key: ${e.message}`, cause: e}),
      ),
    )

    if (!accountKey.publicKey || !accountKey.chainCode) {
      return yield* Effect.fail(new WalletCreationError({message: `Missing public key material at ${path}`}))
    }

    const accountXPub = new Uint8Array(accountKey.publicKey.length + accountKey.chainCode.length)
    accountXPub.set(accountKey.publicKey, 0)
    accountXPub.set(accountKey.chainCode, accountKey.publicKey.length)
    return accountXPub
  })

/**
 * secp256k1 account xpub (Bitcoin BIP-84 / EVM BIP-44) via the BO-1 primitive
 * `secp256k1AccountXpub`. Stored as 33-byte compressed pubkey ‖ 32-byte chain
 * code (65 bytes) — the neutered material a later CKDpub (`secp256k1PublicChild`)
 * consumes for seedless receive/change discovery.
 */
const secp256k1AccountXpubBytes = (mnemonic: string, path: string): Effect.Effect<Uint8Array, DerivationError> =>
  Effect.tryPromise({
    try: () => mnemonicToSeed(mnemonic),
    catch: (cause) =>
      new DerivationError({message: `Failed to derive seed for account xpub: ${causeMessage(cause)}`, path}),
  }).pipe(
    Effect.flatMap((seed) =>
      Effect.try({
        try: () => {
          const node = HDKey.fromExtendedKey(secp256k1AccountXpub(seed, path))
          if (node.publicKey === null || node.chainCode === null) {
            throw new Error('derived account node is missing public-key material')
          }
          const out = new Uint8Array(node.publicKey.length + node.chainCode.length)
          out.set(node.publicKey, 0)
          out.set(node.chainCode, node.publicKey.length)
          return out
        },
        catch: (cause) =>
          new DerivationError({message: `Failed to derive secp256k1 account xpub: ${causeMessage(cause)}`, path}),
      }),
    ),
  )

/**
 * Cardano account xpub (CIP-1852 `m/1852'/1815'/account'`) via
 * {@link deriveCardanoAccountXpub}. Stored as 32-byte Ed25519 pubkey ‖ 32-byte
 * chain code (64 bytes), matching the layout `createFromXPub`/`cacheAccountXPub`
 * persist for the cardano family.
 */
const cardanoAccountXpubBytes = (mnemonic: string, accountIndex: number): Effect.Effect<Uint8Array, DerivationError> =>
  deriveCardanoAccountXpub(mnemonic, accountIndex).pipe(
    Effect.flatMap((xpubHex) =>
      Either.match(hex.decode(xpubHex), {
        onLeft: (e) =>
          Effect.fail(
            new DerivationError({
              message: `Failed to decode Cardano account xpub: ${e.message}`,
              path: `m/1852'/1815'/${accountIndex}'`,
            }),
          ),
        onRight: (bytes) => Effect.succeed(bytes),
      }),
    ),
  )

/**
 * Derive the account-level extended public key (public material only) for a
 * chain, resolved by CAIP-2 namespace:
 *
 * - `midnight` — secp256k1 BIP-32 at m/44'/2400'/account' (65-byte pubkey‖cc).
 * - `bip122` (Bitcoin) — secp256k1 BIP-84 at m/84'/0'/account' (65-byte).
 * - `eip155` (EVM) — secp256k1 BIP-44 at m/44'/60'/account' (65-byte).
 * - `cardano` — BIP32-Ed25519 CIP-1852 at m/1852'/1815'/account' (64-byte).
 *
 * Solana and any other namespace fail with a {@link DerivationError}: SLIP-0010
 * ed25519 has no public-child derivation, so its account xpub can't seed
 * seedless discovery and is not persisted.
 */
export const deriveAccountXPub = (
  mnemonic: string,
  chainId: ChainId,
  accountIndex: number,
): Effect.Effect<Uint8Array, WalletCreationError | DerivationError> => {
  switch (getChainNamespace(chainId)) {
    case 'midnight':
      return midnightAccountXpub(mnemonic, chainId, accountIndex)
    case 'bip122':
      return secp256k1AccountXpubBytes(mnemonic, `m/84'/0'/${accountIndex}'`)
    case 'eip155':
      return secp256k1AccountXpubBytes(mnemonic, `m/44'/60'/${accountIndex}'`)
    case 'cardano':
      return cardanoAccountXpubBytes(mnemonic, accountIndex)
    default:
      return Effect.fail(new DerivationError({message: `Account xpub derivation not supported for chain: ${chainId}`}))
  }
}

/** Adapt {@link deriveAccountXPub} failures to the WalletCreationError channel used by manager APIs. */
const deriveAccountXPubForCreation = (
  mnemonic: string,
  chainId: ChainId,
  accountIndex: number,
): Effect.Effect<Uint8Array, WalletCreationError> =>
  deriveAccountXPub(mnemonic, chainId, accountIndex).pipe(
    Effect.catchTag('DerivationError', (e) => Effect.fail(new WalletCreationError({message: e.message, cause: e}))),
  )

// ============================================================================
// WalletManager implementation
// ============================================================================

export const createWalletManager = (config: WalletManagerConfig = {}): Effect.Effect<WalletManager> =>
  Effect.gen(function* () {
    const groups = yield* Ref.make<ReadonlyMap<WalletGroupId, WalletGroup>>(new Map())
    const selection = yield* Ref.make<WalletSelection | null>(null)
    const allChainIds = config.allChainIds
    const logger = config.logger ?? createLogger()

    const xpubStore = createXPubStore()

    // === Helpers ===

    const getGroup = (groupId: WalletGroupId): Effect.Effect<WalletGroup, WalletNotFoundError> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(groups)
        const group = map.get(groupId)
        if (!group) return yield* Effect.fail(new WalletNotFoundError({groupId}))
        return group
      })

    const getChainConfig = (
      groupId: WalletGroupId,
      chainId: ChainId,
    ): Effect.Effect<ChainConfig, WalletNotFoundError> =>
      Effect.gen(function* () {
        const group = yield* getGroup(groupId)
        const chain = group.chains.get(chainId)
        if (!chain) return yield* Effect.fail(new WalletNotFoundError({groupId: `${groupId}:${chainId}`}))
        return chain
      })

    const updateGroup = (
      groupId: WalletGroupId,
      update: (group: WalletGroup) => WalletGroup,
    ): Effect.Effect<WalletGroup, WalletNotFoundError> =>
      Effect.gen(function* () {
        const group = yield* getGroup(groupId)
        const updated = update(group)
        yield* Ref.update(groups, (map) => new Map([...map, [groupId, updated]]))
        return updated
      })

    const updateChainConfig = (
      groupId: WalletGroupId,
      chainId: ChainId,
      update: (config: ChainConfig) => ChainConfig,
    ): Effect.Effect<ChainConfig, WalletNotFoundError> =>
      Effect.gen(function* () {
        const chain = yield* getChainConfig(groupId, chainId)
        const updated = update(chain)
        yield* updateGroup(groupId, (g) => {
          const newChains = new Map(g.chains)
          newChains.set(chainId, updated)
          return {...g, chains: newChains}
        })
        return updated
      })

    const addChainToGroup = (
      groupId: WalletGroupId,
      chainId: ChainId,
      chainConfig: ChainConfig,
    ): Effect.Effect<WalletGroup, WalletNotFoundError> =>
      updateGroup(groupId, (g) => {
        const newChains = new Map(g.chains)
        newChains.set(chainId, chainConfig)
        return {...g, chains: newChains}
      })

    // === Creation ===

    const createFromMnemonic = (params: CreateFromMnemonicParams): Effect.Effect<WalletGroup, WalletCreationError> =>
      Effect.gen(function* () {
        const groupId = params.groupId ?? generateGroupId()
        const t0 = performance.now()

        // Pre-derive xpubs for all configured chains — clear the seed cache when done
        // so the plaintext mnemonic doesn't linger in memory.
        const existingXPubs = xpubStore.getAllForGroup(groupId)
        if (allChainIds && existingXPubs.size === 0) {
          for (const cId of allChainIds) {
            // Skip chains with no account-xpub concept (Solana / unknown)
            // explicitly — never by catching a derivation error.
            if (!ACCOUNT_XPUB_NAMESPACES.has(getChainNamespace(cId))) continue
            const tDeriv = performance.now()
            // A supported chain that fails to derive is a real bug — surface it.
            const xpub = yield* deriveAccountXPubForCreation(params.mnemonic, cId, 0)
            xpubStore.set({groupId, chainId: cId, accountIndex: 0}, xpub)
            logger.debug('Pre-derived xpub', {
              origin: 'WalletManager',
              chainId: cId,
              ms: Math.round(performance.now() - tDeriv),
            })
          }
        }

        // Ensure the requested chain's xpub is derived
        const existingXPub = xpubStore.get({groupId, chainId: params.chainId, accountIndex: 0})
        if (Option.isNone(existingXPub)) {
          const tDeriv = performance.now()
          const xpub = yield* deriveAccountXPubForCreation(params.mnemonic, params.chainId, 0)
          xpubStore.set({groupId, chainId: params.chainId, accountIndex: 0}, xpub)
          logger.debug('Derived xpub', {
            origin: 'WalletManager',
            chainId: params.chainId,
            ms: Math.round(performance.now() - tDeriv),
          })
        } else {
          logger.debug('Xpub cache hit', {origin: 'WalletManager', chainId: params.chainId})
        }

        const implementation = params.implementation ?? (yield* implementationFor(params.chainId))

        const chainConfig: ChainConfig = {
          implementation,
          accounts: [{index: 0, enabled: true}],
          selectedAccountIndex: 0,
        }

        // Seed persistence is the app layer's job — the enclave vault
        // (WalletProvider) writes the mnemonic to the OS keychain. The
        // wallet-manager only handles the in-memory wallet build.

        // Get or create the group
        const map = yield* Ref.get(groups)
        const existingGroup = map.get(groupId)

        if (existingGroup) {
          // Upgrade-in-place: a placeholder group (imported-xpriv keys-only or
          // read-only xpub-only) now has a seed and full signing capability,
          // so bump source to 'mnemonic' (or whatever the caller supplied) and
          // clear any stale hardware flags.
          const needsUpgrade =
            existingGroup.source === 'imported-xpriv' ||
            existingGroup.source === 'read-only' ||
            existingGroup.isHardware === true
          if (needsUpgrade) {
            const nextSource = params.source ?? 'mnemonic'
            yield* updateGroup(groupId, (g) => {
              const {isHardware: _isHardware, hardwareDeviceType: _hwType, ...rest} = g
              return {...rest, source: nextSource}
            }).pipe(
              Effect.mapError(
                (e) => new WalletCreationError({message: `Failed to upgrade group source: ${String(e)}`, cause: e}),
              ),
            )
          }
          // Skip addChainToGroup when the chain is already present — the helper
          // would otherwise unconditionally overwrite the existing ChainConfig
          // (including any multi-account `accounts`/`selectedAccountIndex`
          // state) with a freshly-constructed single-account default. Today
          // multi-account UI is dormant so this is defence-in-depth, but the
          // upgrade-in-place loop in `preparing.tsx` iterates every default
          // chain regardless of presence, so the overwrite would fire on
          // every Cardano re-import.
          if (existingGroup.chains.has(params.chainId)) {
            logger.debug('Chain already present on existing group, skipping addChainToGroup', {
              origin: 'WalletManager',
              groupId,
              chainId: params.chainId,
              totalMs: Math.round(performance.now() - t0),
            })
            return yield* getGroup(groupId).pipe(
              Effect.mapError(
                (e) => new WalletCreationError({message: `Failed to read group after upgrade: ${String(e)}`, cause: e}),
              ),
            )
          }
          logger.debug('Adding chain to existing group', {
            origin: 'WalletManager',
            groupId,
            chainId: params.chainId,
            totalMs: Math.round(performance.now() - t0),
          })
          return yield* addChainToGroup(groupId, params.chainId, chainConfig).pipe(
            Effect.mapError(
              (e) => new WalletCreationError({message: `Failed to add chain to group: ${String(e)}`, cause: e}),
            ),
          )
        }

        // Create new group
        const group: WalletGroup = {
          groupId,
          name: params.name,
          createdAt: new Date(),
          source: params.source ?? 'mnemonic',
          chains: new Map([[params.chainId, chainConfig]]),
        }

        yield* Ref.update(groups, (m) => new Map([...m, [groupId, group]]))
        logger.debug('Group created', {
          origin: 'WalletManager',
          groupId,
          chainId: params.chainId,
          totalMs: Math.round(performance.now() - t0),
        })
        return group
      })

    const createFromXPub = (params: CreateFromXPubParams): Effect.Effect<WalletGroup, WalletCreationError, never> =>
      Effect.gen(function* () {
        const family = yield* chainFamilyFor(params.chainId)

        if (family === 'cardano') {
          if (params.publicKey.length !== 32) {
            return yield* Effect.fail(
              new WalletCreationError({
                message: `Invalid public key length for ${params.chainId}: ${params.publicKey.length}, expected 32`,
              }),
            )
          }
        } else {
          if (params.publicKey.length !== 33) {
            return yield* Effect.fail(
              new WalletCreationError({
                message: `Invalid public key length for ${params.chainId}: ${params.publicKey.length}, expected 33`,
              }),
            )
          }
        }
        if (params.chainCode.length !== 32) {
          return yield* Effect.fail(
            new WalletCreationError({message: `Invalid chain code length: ${params.chainCode.length}, expected 32`}),
          )
        }

        const implementation = yield* implementationFor(params.chainId)

        const groupId = params.groupId ?? generateGroupId()
        const accountXPub = new Uint8Array(params.publicKey.length + 32)
        accountXPub.set(params.publicKey, 0)
        accountXPub.set(params.chainCode, params.publicKey.length)
        xpubStore.set({groupId, chainId: params.chainId, accountIndex: 0}, accountXPub)

        const chainConfig: ChainConfig = {
          implementation,
          accounts: [{index: 0, enabled: true}],
          selectedAccountIndex: 0,
        }

        // Get or create group (hardware import calls createFromXPub per chain with the same groupId)
        const map = yield* Ref.get(groups)
        const existingGroup = map.get(groupId)

        if (existingGroup) {
          return yield* addChainToGroup(groupId, params.chainId, chainConfig).pipe(
            Effect.mapError(
              (e) => new WalletCreationError({message: `Failed to add chain to group: ${String(e)}`, cause: e}),
            ),
          )
        }

        const group: WalletGroup = {
          groupId,
          name: params.name,
          createdAt: new Date(),
          source: params.source ?? 'hardware',
          ...(params.isHardware ? {isHardware: params.isHardware} : {}),
          ...(params.hardwareDeviceType ? {hardwareDeviceType: params.hardwareDeviceType} : {}),
          chains: new Map([[params.chainId, chainConfig]]),
        }

        yield* Ref.update(groups, (m) => new Map([...m, [groupId, group]]))
        return group
      })

    const cacheAccountXPub = (params: CacheAccountXPubParams): Effect.Effect<void, WalletCreationError, never> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(groups)
        if (!map.has(params.groupId)) {
          return yield* Effect.fail(new WalletCreationError({message: `Group not found: ${params.groupId}`}))
        }

        const family = yield* chainFamilyFor(params.chainId)

        if (family === 'cardano') {
          if (params.publicKey.length !== 32) {
            return yield* Effect.fail(
              new WalletCreationError({
                message: `Invalid public key length for ${params.chainId}: ${params.publicKey.length}, expected 32`,
              }),
            )
          }
        } else {
          if (params.publicKey.length !== 33) {
            return yield* Effect.fail(
              new WalletCreationError({
                message: `Invalid public key length for ${params.chainId}: ${params.publicKey.length}, expected 33`,
              }),
            )
          }
        }
        if (params.chainCode.length !== 32) {
          return yield* Effect.fail(
            new WalletCreationError({message: `Invalid chain code length: ${params.chainCode.length}, expected 32`}),
          )
        }

        const accountXPub = new Uint8Array(params.publicKey.length + 32)
        accountXPub.set(params.publicKey, 0)
        accountXPub.set(params.chainCode, params.publicKey.length)
        xpubStore.set(
          {groupId: params.groupId, chainId: params.chainId, accountIndex: params.accountIndex ?? 0},
          accountXPub,
        )
      })

    const createReadOnly = (params: CreateReadOnlyParams): Effect.Effect<WalletGroup, WalletCreationError, never> =>
      Effect.gen(function* () {
        if (params.addresses.length === 0) {
          return yield* Effect.fail(
            new WalletCreationError({message: 'At least one address is required for read-only wallet'}),
          )
        }

        const groupId = params.groupId ?? generateGroupId()

        // Idempotent re-add: a repeat with the same deterministic groupId returns
        // the existing group rather than creating a duplicate.
        const existing = (yield* Ref.get(groups)).get(groupId)
        if (existing) return existing

        const group: WalletGroup = {
          groupId,
          name: params.name,
          createdAt: new Date(),
          source: params.source ?? 'read-only',
          // Read-only wallets have no xpub, so seed the checksum/identicon from
          // the caller-supplied stable seed (the stake key hash).
          ...(params.checksumSeed ? {checksum: walletChecksum(params.checksumSeed)} : {}),
          chains: new Map([
            [
              params.chainId,
              {
                // A shared wallet derives from a script template, not from a key
                // chain, and is not read-only — it receives, and spends once its
                // quorum signs.
                implementation: params.source === 'multisig' ? ('cip1854' as const) : ('readOnly' as const),
                accounts: [{index: 0, enabled: true}],
                selectedAccountIndex: 0,
                // No key of ours derives these, so this is their only durable copy —
                // see `ChainConfig.nonDerivedAddresses`.
                nonDerivedAddresses: params.addresses,
              },
            ],
          ]),
        }

        yield* Ref.update(groups, (m) => new Map([...m, [groupId, group]]))
        return group
      })

    const createFromDevice = (params: CreateFromDeviceParams): Effect.Effect<WalletGroup, WalletCreationError, never> =>
      Effect.gen(function* () {
        if (params.publicKeys.length === 0) {
          return yield* Effect.fail(
            new WalletCreationError({message: 'At least one public key is required for hardware wallet'}),
          )
        }

        const implementation = yield* implementationFor(params.chainId)
        const groupId = params.groupId ?? generateGroupId()

        // Store all account xpubs under the device account index each was
        // derived at — never the array position (see `CreateFromDeviceParams`).
        for (const {publicKey, chainCode, accountIndex} of params.publicKeys) {
          const accountXPub = new Uint8Array(publicKey.length + chainCode.length)
          accountXPub.set(publicKey, 0)
          accountXPub.set(chainCode, publicKey.length)
          xpubStore.set({groupId, chainId: params.chainId, accountIndex}, accountXPub)
        }

        const firstAccountIndex = params.publicKeys[0]?.accountIndex ?? 0
        const chainConfig: ChainConfig = {
          implementation,
          accounts: params.publicKeys.map(({accountIndex}) => ({
            index: accountIndex,
            enabled: accountIndex === firstAccountIndex,
          })),
          selectedAccountIndex: firstAccountIndex,
        }

        // Get or create group (hardware import calls createFromDevice per chain)
        const map = yield* Ref.get(groups)
        const existingGroup = map.get(groupId)

        if (existingGroup) {
          return yield* addChainToGroup(groupId, params.chainId, chainConfig).pipe(
            Effect.mapError(
              (e) => new WalletCreationError({message: `Failed to add chain to group: ${String(e)}`, cause: e}),
            ),
          )
        }

        const group: WalletGroup = {
          groupId,
          name: params.name,
          createdAt: new Date(),
          source: params.source ?? 'hardware',
          isHardware: true,
          hardwareDeviceType: params.deviceType,
          chains: new Map([[params.chainId, chainConfig]]),
        }

        yield* Ref.update(groups, (m) => new Map([...m, [groupId, group]]))
        return group
      })

    // === Queries ===

    const getXPub = (
      groupId: WalletGroupId,
      chainId: ChainId,
      accountIndex: number,
    ): Effect.Effect<Uint8Array, WalletNotFoundError> =>
      Effect.gen(function* () {
        const xpub = xpubStore.get({groupId, chainId, accountIndex})
        if (Option.isNone(xpub)) {
          return yield* Effect.fail(new WalletNotFoundError({groupId: `${groupId}:${chainId}:${accountIndex}`}))
        }
        return xpub.value
      })

    // === Account xpub persistence (create/restore) ===

    // Derive + persist the account-0 xpub for the configured chains and the
    // derive-only chains (BTC/EVM/ADA). Idempotent per chain (present xpubs are
    // skipped). Chains without an account-xpub concept (Solana / unknown) are
    // skipped explicitly; a supported chain that fails to derive surfaces as a
    // WalletCreationError (never swallowed). Public material only; the caller
    // supplies the mnemonic from wallet create/restore.
    const ensureAccountXpubs = (
      groupId: WalletGroupId,
      mnemonic: string,
    ): Effect.Effect<readonly ChainId[], WalletCreationError> =>
      Effect.gen(function* () {
        const targets = new Set<ChainId>([...(allChainIds ?? []), ...DERIVE_ONLY_XPUB_CHAIN_IDS])
        const added: ChainId[] = []
        for (const chainId of targets) {
          if (Option.isSome(xpubStore.get({groupId, chainId, accountIndex: 0}))) continue
          // Chains with no account-xpub concept are skipped explicitly — never by
          // catching a derivation error (which used to silently drop e.g. Cardano).
          if (!ACCOUNT_XPUB_NAMESPACES.has(getChainNamespace(chainId))) continue
          // A supported chain that fails to derive is a real bug — surface it.
          const xpub = yield* deriveAccountXPubForCreation(mnemonic, chainId, 0)
          xpubStore.set({groupId, chainId, accountIndex: 0}, xpub)
          added.push(chainId)
        }
        return added
      })

    const packAccountXpub = (publicKey: Uint8Array, chainCode: Uint8Array): Uint8Array => {
      const accountXPub = new Uint8Array(publicKey.length + chainCode.length)
      accountXPub.set(publicKey, 0)
      accountXPub.set(chainCode, publicKey.length)
      return accountXPub
    }

    /**
     * Store account-level xpubs derived by a HARDWARE device for derive-only
     * chains (BTC/EVM) at `accountIndex`, without registering a full chain (they
     * have no chain implementation — createFromDevice would fail "unsupported
     * chain"). The receive address is rebuilt from the xpub on read, exactly
     * like the seed-based `ensureAccountXpubs`. Idempotent per chain+index.
     */
    const setDeviceAccountXpubs = (
      groupId: WalletGroupId,
      entries: readonly {readonly chainId: ChainId; readonly publicKey: Uint8Array; readonly chainCode: Uint8Array}[],
      accountIndex = 0,
    ): Effect.Effect<readonly ChainId[], never> =>
      Effect.sync(() => {
        const added: ChainId[] = []
        for (const {chainId, publicKey, chainCode} of entries) {
          if (Option.isSome(xpubStore.get({groupId, chainId, accountIndex}))) continue
          xpubStore.set({groupId, chainId, accountIndex}, packAccountXpub(publicKey, chainCode))
          added.push(chainId)
        }
        return added
      })

    /**
     * Add a device-derived account at `accountIndex` to an existing hardware
     * group: store the chain's account xpub and register + enable the account
     * (making it the selected one). The derive-only companion chains for the
     * same index are stored separately by the caller. Used by the hardware
     * "add account" flow — the equivalent of the seed-based `scanAccounts`.
     */
    const addDeviceAccount = (
      groupId: WalletGroupId,
      chainId: ChainId,
      accountIndex: number,
      key: {readonly publicKey: Uint8Array; readonly chainCode: Uint8Array},
    ): Effect.Effect<WalletGroup, WalletNotFoundError> =>
      Effect.gen(function* () {
        const group = yield* getGroup(groupId)
        xpubStore.set({groupId, chainId, accountIndex}, packAccountXpub(key.publicKey, key.chainCode))
        const chains = new Map(group.chains)
        const cc = chains.get(chainId)
        if (cc) {
          const has = cc.accounts.some((a) => a.index === accountIndex)
          const accounts = has
            ? cc.accounts.map((a) => (a.index === accountIndex ? {...a, enabled: true} : a))
            : [...cc.accounts, {index: accountIndex, enabled: true}]
          chains.set(chainId, {...cc, accounts, selectedAccountIndex: accountIndex})
        }
        const updated: WalletGroup = {...group, chains}
        yield* Ref.update(groups, (m) => new Map(m).set(groupId, updated))
        return updated
      })

    // === Selection ===

    const select = (sel: WalletSelection): Effect.Effect<void, WalletNotFoundError> =>
      Effect.gen(function* () {
        yield* getGroup(sel.groupId) // verify exists
        yield* Ref.set(selection, sel)
      })

    const deselect = (): Effect.Effect<void, never> => Ref.set(selection, null)

    // === Deletion ===

    const deleteGroup = (groupId: WalletGroupId): Effect.Effect<void, WalletNotFoundError> =>
      Effect.gen(function* () {
        yield* getGroup(groupId) // verify exists

        yield* Ref.update(groups, (map) => {
          const newMap = new Map(map)
          newMap.delete(groupId)
          return newMap
        })

        xpubStore.deleteGroup(groupId)

        // Clear selection if this group was selected
        const sel = yield* Ref.get(selection)
        if (sel?.groupId === groupId) {
          yield* Ref.set(selection, null)
        }
      })

    // === Source update ===

    const updateSource = (
      groupId: WalletGroupId,
      source: WalletSource,
    ): Effect.Effect<WalletGroup, WalletNotFoundError> =>
      Effect.gen(function* () {
        const group = yield* getGroup(groupId)
        const updated: WalletGroup = {...group, source}
        yield* Ref.update(groups, (map) => new Map(map).set(groupId, updated))
        return updated
      })

    // === Chain enable/disable ===

    const enableChain = (
      groupId: WalletGroupId,
      chainId: ChainId,
      opts?: {readonly mnemonic?: string},
    ): Effect.Effect<WalletGroup, WalletCreationError | StorageError> =>
      Effect.gen(function* () {
        const group = yield* getGroup(groupId).pipe(
          Effect.mapError((e) => new WalletCreationError({message: String(e), cause: e})),
        )

        // Check if xpub is already pre-derived (fast path)
        const existingXPub = xpubStore.get({groupId, chainId, accountIndex: 0})
        if (Option.isSome(existingXPub)) {
          const implementation = yield* implementationFor(chainId)
          const chainConfig: ChainConfig = {
            implementation,
            accounts: [{index: 0, enabled: true}],
            selectedAccountIndex: 0,
          }
          return yield* addChainToGroup(groupId, chainId, chainConfig).pipe(
            Effect.mapError((e) => new WalletCreationError({message: String(e), cause: e})),
          )
        }

        // Slow path: need a mnemonic to derive the xpub. The caller
        // provides it directly — the WalletProvider retrieves it via the
        // enclave vault (OS biometric / device-passcode prompt) so this
        // layer never touches credentials.
        const mnemonic = opts?.mnemonic
        if (!mnemonic) {
          return yield* Effect.fail(new WalletCreationError({message: 'XPUB_NOT_FOUND_AUTH_REQUIRED'}))
        }
        return yield* createFromMnemonic({
          name: group.name,
          mnemonic,
          chainId,
          groupId,
        })
      })

    const disableChain = (groupId: WalletGroupId, chainId: ChainId): Effect.Effect<WalletGroup, WalletNotFoundError> =>
      updateGroup(groupId, (g) => {
        const newChains = new Map(g.chains)
        newChains.delete(chainId)
        return {...g, chains: newChains}
      })

    // === Account scanning ===

    const scanAccounts = (
      groupId: WalletGroupId,
      chainId: ChainId,
      mnemonic: string,
      count = 20,
    ): Effect.Effect<ChainConfig, WalletCreationError | WalletNotFoundError> =>
      Effect.gen(function* () {
        const chain = yield* getChainConfig(groupId, chainId)

        for (let i = 0; i < count; i++) {
          if (Option.isSome(xpubStore.get({groupId, chainId, accountIndex: i}))) continue
          const xpub = yield* deriveAccountXPubForCreation(mnemonic, chainId, i)
          xpubStore.set({groupId, chainId, accountIndex: i}, xpub)
        }

        const existingByIndex = new Map(chain.accounts.map((a) => [a.index, a]))
        const accounts: AccountEntry[] = Array.from({length: count}, (_, i) => {
          const existing = existingByIndex.get(i)
          return existing ?? {index: i, enabled: i === 0}
        })

        return yield* updateChainConfig(groupId, chainId, (c) => ({...c, accounts}))
      })

    const scanAccountsFromXPubs = (
      groupId: WalletGroupId,
      chainId: ChainId,
      xpubs: ReadonlyArray<{readonly index: number; readonly xpub: Uint8Array}>,
    ): Effect.Effect<ChainConfig, WalletNotFoundError> =>
      Effect.gen(function* () {
        const chain = yield* getChainConfig(groupId, chainId)

        for (const {index, xpub} of xpubs) {
          xpubStore.set({groupId, chainId, accountIndex: index}, xpub)
        }

        const existingByIndex = new Map(chain.accounts.map((a) => [a.index, a]))
        const allIndices = new Set([...chain.accounts.map((a) => a.index), ...xpubs.map((x) => x.index)])
        const accounts: AccountEntry[] = [...allIndices]
          .sort((a, b) => a - b)
          .map((i) => existingByIndex.get(i) ?? {index: i, enabled: i === 0})

        return yield* updateChainConfig(groupId, chainId, (c) => ({...c, accounts}))
      })

    const enableAccount = (
      groupId: WalletGroupId,
      chainId: ChainId,
      accountIndex: number,
    ): Effect.Effect<ChainConfig, WalletNotFoundError> =>
      updateChainConfig(groupId, chainId, (c) => ({
        ...c,
        accounts: c.accounts.map((a) => (a.index === accountIndex ? {...a, enabled: true} : a)),
      }))

    const disableAccount = (
      groupId: WalletGroupId,
      chainId: ChainId,
      accountIndex: number,
    ): Effect.Effect<ChainConfig, WalletNotFoundError> =>
      Effect.gen(function* () {
        if (accountIndex === 0) return yield* getChainConfig(groupId, chainId) // no-op
        return yield* updateChainConfig(groupId, chainId, (c) => ({
          ...c,
          accounts: c.accounts.map((a) => (a.index === accountIndex ? {...a, enabled: false} : a)),
        }))
      })

    // === Persistence ===

    const storageError = (msg: string) => (e: {message?: string}) =>
      new StorageError({message: `${msg}: ${e.message ?? String(e)}`, cause: e})

    const save = (): Effect.Effect<void, StorageError, Storage> =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const map = yield* Ref.get(groups)
        const sel = yield* Ref.get(selection)

        const groupsData = JSON.stringify(Array.from(map.values()).map(serializeGroup))
        yield* storage.set(STORAGE_KEY, groupsData).pipe(Effect.mapError(storageError('Failed to save groups')))

        yield* storage
          .set(XPUB_STORE_KEY, xpubStore.serialize())
          .pipe(Effect.mapError(storageError('Failed to save xpub store')))

        if (sel) {
          yield* storage
            .set(SELECTED_KEY, JSON.stringify(sel))
            .pipe(Effect.mapError(storageError('Failed to save selection')))
        } else {
          yield* storage.remove(SELECTED_KEY).pipe(Effect.mapError(storageError('Failed to clear selection')))
        }
      })

    const load = (): Effect.Effect<void, StorageError, Storage> =>
      Effect.gen(function* () {
        const storage = yield* Storage

        // Load groups
        const groupsJson = yield* storage.get(STORAGE_KEY).pipe(Effect.mapError(storageError('Failed to load groups')))

        if (groupsJson) {
          try {
            const parsed = JSON.parse(groupsJson) as SerializedWalletGroup[]
            const map = new Map<WalletGroupId, WalletGroup>()
            for (const data of parsed) map.set(data.groupId as WalletGroupId, deserializeGroup(data))
            yield* Ref.set(groups, map)
          } catch (e) {
            return yield* Effect.fail(new StorageError({message: `Failed to parse groups: ${String(e)}`, cause: e}))
          }

          // Load xpub store
          const xpubStoreJson = yield* storage
            .get(XPUB_STORE_KEY)
            .pipe(Effect.mapError(storageError('Failed to load xpub store')))

          if (xpubStoreJson) {
            try {
              xpubStore.deserialize(xpubStoreJson)
            } catch (e) {
              return yield* Effect.fail(
                new StorageError({message: `Failed to parse xpub store: ${String(e)}`, cause: e}),
              )
            }
          }

          // Load selection
          const selJson = yield* storage
            .get(SELECTED_KEY)
            .pipe(Effect.mapError(storageError('Failed to load selection')))

          if (selJson) {
            try {
              const sel = JSON.parse(selJson) as WalletSelection
              yield* Ref.set(selection, sel)
            } catch (e: unknown) {
              // Ignoring it resets the app to its default wallet, which reads as a fresh install
              // rather than as a selection that could not be restored.
              logger.warn('Stored wallet selection could not be parsed; falling back to the default', {
                origin: 'wallet-manager',
                error: String(e),
              })
            }
          }
        }
      })

    // Preferred chain order for checksum derivation
    const checksumChainPreference: readonly ChainId[] = [MIDNIGHT_MAINNET]

    const attachChecksum = (groupId: WalletGroupId): Effect.Effect<WalletChecksum | undefined, WalletNotFoundError> =>
      Effect.gen(function* () {
        const group = yield* getGroup(groupId)
        if (group.checksum) return group.checksum

        // Try preferred chains first, then any chain in the group
        const candidates = [
          ...checksumChainPreference.filter((c) => group.chains.has(c)),
          ...[...group.chains.keys()].filter((c) => !checksumChainPreference.includes(c)),
        ]

        let xpub: Uint8Array | undefined
        for (const candidate of candidates) {
          const result = xpubStore.get({groupId, chainId: candidate, accountIndex: 0})
          if (Option.isSome(result)) {
            xpub = result.value
            break
          }
        }
        if (!xpub) return undefined

        const hexString = Array.from(xpub)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')
        const checksum = walletChecksum(hexString)

        yield* updateGroup(groupId, (g) => ({...g, checksum}))
        return checksum
      })

    return {
      groups,
      selection,
      createFromMnemonic,
      createFromXPub,
      cacheAccountXPub,
      createReadOnly,
      createFromDevice,
      getGroup,
      getChainConfig,
      getXPub,
      ensureAccountXpubs,
      setDeviceAccountXpubs,
      addDeviceAccount,
      select,
      deselect,
      deleteGroup,
      updateSource,
      enableChain,
      disableChain,
      scanAccounts,
      scanAccountsFromXPubs,
      enableAccount,
      disableAccount,
      attachChecksum,
      save,
      load,
    }
  })

/**
 * WalletManager Layer.
 */
export const WalletManagerLayer = Layer.effect(WalletManager, createWalletManager())
