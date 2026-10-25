/**
 * Hardware wallet storage service.
 *
 * Stores metadata about hardware wallet connections, including:
 * - Device type (Ledger/Trezor)
 * - Device model and firmware version
 * - Account derivation paths used
 * - Last connection time
 *
 * This supplements the main wallet storage by tracking hardware-specific metadata
 * that doesn't fit into the core WalletMeta structure.
 *
 * @module
 */

import {getLogger} from '@pnyx/logger'
import {Storage} from '@pnyx/storage'
import {Context, Data, Effect, Layer} from 'effect'

// Local branded type — structurally identical to the wallet package's WalletGroupId
// but avoids adding @pnyx/wallet as a dependency of ./index.js
type GroupId = string & {readonly __brand: 'WalletGroupId'}

const logger = getLogger('hardware')

// ============================================================================
// Types
// ============================================================================

/**
 * Error for hardware wallet storage operations.
 */
export class HardwareWalletStorageError extends Data.TaggedError('HardwareWalletStorageError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Device type for hardware wallets.
 */
export type HardwareDeviceType = 'ledger' | 'trezor'

/**
 * Hardware wallet metadata stored alongside the main wallet data.
 */
export type HardwareWalletMeta = {
  /** Wallet group ID from the main wallet system */
  readonly groupId: GroupId
  /** Type of hardware wallet */
  readonly deviceType: HardwareDeviceType
  /** Device model (e.g., 'nanoX', 'T') */
  readonly deviceModel: string
  /** Firmware version at time of wallet creation */
  readonly firmwareVersion: string
  /** Device serial number or ID (for reconnection) */
  readonly deviceId?: string
  /** User-assigned device label */
  readonly deviceLabel?: string
  /** BLE device ID for Bluetooth reconnection (mobile only) */
  readonly bleDeviceId?: string
  /**
   * Transport kind the device was paired over. Persisted so a cold-start
   * auto-reconnect picks the right transport — without it the platform
   * default (BLE on Android) wins, which fails on USB-paired Ledgers.
   * Older meta records may omit this; consumers fall back to
   * `bleDeviceId ? 'ble' : null` to keep historical pairings working.
   */
  readonly transportHint?: 'usb' | 'ble'
  /** Account derivation path used */
  readonly derivationPath: string
  /** Account index */
  readonly accountIndex: number
  /** When the wallet was created/connected */
  readonly createdAt: Date
  /** Last successful connection */
  readonly lastConnectedAt?: Date
}

/**
 * Serialized form for storage.
 */
type SerializedHardwareWalletMeta = {
  readonly groupId: string
  readonly deviceType: HardwareDeviceType
  readonly deviceModel: string
  readonly firmwareVersion: string
  readonly deviceId?: string
  readonly deviceLabel?: string
  readonly bleDeviceId?: string
  readonly transportHint?: 'usb' | 'ble'
  readonly derivationPath: string
  readonly accountIndex: number
  readonly createdAt: string // ISO date
  readonly lastConnectedAt?: string // ISO date
}

// ============================================================================
// Constants
// ============================================================================

const STORAGE_KEY = './index.js'

// ============================================================================
// Serialization
// ============================================================================

/**
 * Serialize hardware wallet meta for storage.
 */
const serialize = (meta: HardwareWalletMeta): SerializedHardwareWalletMeta => ({
  groupId: meta.groupId,
  deviceType: meta.deviceType,
  deviceModel: meta.deviceModel,
  firmwareVersion: meta.firmwareVersion,
  ...(meta.deviceId !== undefined ? {deviceId: meta.deviceId} : {}),
  ...(meta.deviceLabel !== undefined ? {deviceLabel: meta.deviceLabel} : {}),
  ...(meta.bleDeviceId !== undefined ? {bleDeviceId: meta.bleDeviceId} : {}),
  ...(meta.transportHint !== undefined ? {transportHint: meta.transportHint} : {}),
  derivationPath: meta.derivationPath,
  accountIndex: meta.accountIndex,
  createdAt: meta.createdAt.toISOString(),
  ...(meta.lastConnectedAt !== undefined ? {lastConnectedAt: meta.lastConnectedAt.toISOString()} : {}),
})

/**
 * Deserialize hardware wallet meta from storage.
 */
const deserialize = (data: SerializedHardwareWalletMeta): HardwareWalletMeta => ({
  groupId: data.groupId as GroupId,
  deviceType: data.deviceType,
  deviceModel: data.deviceModel,
  firmwareVersion: data.firmwareVersion,
  ...(data.deviceId !== undefined ? {deviceId: data.deviceId} : {}),
  ...(data.deviceLabel !== undefined ? {deviceLabel: data.deviceLabel} : {}),
  ...(data.bleDeviceId !== undefined ? {bleDeviceId: data.bleDeviceId} : {}),
  ...(data.transportHint !== undefined ? {transportHint: data.transportHint} : {}),
  derivationPath: data.derivationPath,
  accountIndex: data.accountIndex,
  createdAt: new Date(data.createdAt),
  ...(data.lastConnectedAt !== undefined ? {lastConnectedAt: new Date(data.lastConnectedAt)} : {}),
})

// ============================================================================
// Service Interface
// ============================================================================

/**
 * Hardware wallet storage service interface.
 */
export type HardwareWalletStorage = {
  /**
   * Store hardware wallet metadata.
   */
  readonly store: (meta: HardwareWalletMeta) => Effect.Effect<void, HardwareWalletStorageError>

  /**
   * Get hardware wallet metadata by wallet ID.
   */
  readonly get: (groupId: GroupId) => Effect.Effect<HardwareWalletMeta | null, HardwareWalletStorageError>

  /**
   * List all hardware wallet metadata.
   */
  readonly list: () => Effect.Effect<readonly HardwareWalletMeta[], HardwareWalletStorageError>

  /**
   * Update hardware wallet metadata (e.g., last connected time).
   */
  readonly update: (
    groupId: GroupId,
    updates: Partial<Pick<HardwareWalletMeta, 'deviceLabel' | 'lastConnectedAt' | 'bleDeviceId'>>,
  ) => Effect.Effect<void, HardwareWalletStorageError>

  /**
   * Delete hardware wallet metadata.
   */
  readonly remove: (groupId: GroupId) => Effect.Effect<void, HardwareWalletStorageError>

  /**
   * Check if a wallet is a hardware wallet.
   */
  readonly isHardwareWallet: (groupId: GroupId) => Effect.Effect<boolean, HardwareWalletStorageError>

  /**
   * Get hardware wallets by device type.
   */
  readonly getByDeviceType: (
    deviceType: HardwareDeviceType,
  ) => Effect.Effect<readonly HardwareWalletMeta[], HardwareWalletStorageError>
}

/**
 * HardwareWalletStorage context tag for dependency injection.
 */
export const HardwareWalletStorage = Context.GenericTag<HardwareWalletStorage>('HardwareWalletStorage')

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create the hardware wallet storage service.
 */
export const createHardwareWalletStorage = (): Effect.Effect<HardwareWalletStorage, never, Storage> =>
  Effect.gen(function* () {
    const storage = yield* Storage

    // In-memory cache of hardware wallet metadata
    let cache: Map<GroupId, HardwareWalletMeta> | null = null

    /**
     * Load cache from storage.
     */
    const loadCache = (): Effect.Effect<Map<GroupId, HardwareWalletMeta>, HardwareWalletStorageError> =>
      Effect.gen(function* () {
        if (cache !== null) {
          return cache
        }

        const json = yield* storage.get(STORAGE_KEY).pipe(
          Effect.mapError(
            (e) =>
              new HardwareWalletStorageError({
                message: `Failed to load hardware wallets: ${e.message}`,
                cause: e,
              }),
          ),
        )

        const map = new Map<GroupId, HardwareWalletMeta>()

        if (json) {
          try {
            const data = JSON.parse(json) as SerializedHardwareWalletMeta[]
            for (const item of data) {
              const meta = deserialize(item)
              map.set(meta.groupId, meta)
            }
          } catch (e) {
            logger.warn('Failed to parse hardware wallet storage, starting fresh', {
              origin: 'HardwareWalletStorage',
              error: e,
            })
          }
        }

        cache = map
        return map
      })

    /**
     * Save cache to storage.
     */
    const saveCache = (map: Map<GroupId, HardwareWalletMeta>): Effect.Effect<void, HardwareWalletStorageError> =>
      Effect.gen(function* () {
        const data = Array.from(map.values()).map(serialize)
        const json = JSON.stringify(data)

        yield* storage.set(STORAGE_KEY, json).pipe(
          Effect.mapError(
            (e) =>
              new HardwareWalletStorageError({
                message: `Failed to save hardware wallets: ${e.message}`,
                cause: e,
              }),
          ),
        )

        cache = map
      })

    const store = (meta: HardwareWalletMeta): Effect.Effect<void, HardwareWalletStorageError> =>
      Effect.gen(function* () {
        const map = yield* loadCache()
        const newMap = new Map(map)
        newMap.set(meta.groupId, meta)
        yield* saveCache(newMap)

        logger.info('Hardware wallet metadata stored', {
          origin: 'HardwareWalletStorage',
          groupId: meta.groupId,
          deviceType: meta.deviceType,
        })
      })

    const get = (groupId: GroupId): Effect.Effect<HardwareWalletMeta | null, HardwareWalletStorageError> =>
      Effect.gen(function* () {
        const map = yield* loadCache()
        return map.get(groupId) ?? null
      })

    const list = (): Effect.Effect<readonly HardwareWalletMeta[], HardwareWalletStorageError> =>
      Effect.gen(function* () {
        const map = yield* loadCache()
        return Array.from(map.values())
      })

    const update = (
      groupId: GroupId,
      updates: Partial<Pick<HardwareWalletMeta, 'deviceLabel' | 'lastConnectedAt' | 'bleDeviceId'>>,
    ): Effect.Effect<void, HardwareWalletStorageError> =>
      Effect.gen(function* () {
        const map = yield* loadCache()
        const existing = map.get(groupId)

        if (!existing) {
          return yield* Effect.fail(
            new HardwareWalletStorageError({
              message: `Hardware wallet not found: ${groupId}`,
            }),
          )
        }

        const updated: HardwareWalletMeta = {
          ...existing,
          ...updates,
        }

        const newMap = new Map(map)
        newMap.set(groupId, updated)
        yield* saveCache(newMap)

        logger.debug('Hardware wallet metadata updated', {
          origin: 'HardwareWalletStorage',
          groupId,
        })
      })

    const remove = (groupId: GroupId): Effect.Effect<void, HardwareWalletStorageError> =>
      Effect.gen(function* () {
        const map = yield* loadCache()

        if (!map.has(groupId)) {
          return // Nothing to remove
        }

        const newMap = new Map(map)
        newMap.delete(groupId)
        yield* saveCache(newMap)

        logger.info('Hardware wallet metadata removed', {
          origin: 'HardwareWalletStorage',
          groupId,
        })
      })

    const isHardwareWallet = (groupId: GroupId): Effect.Effect<boolean, HardwareWalletStorageError> =>
      Effect.gen(function* () {
        const map = yield* loadCache()
        return map.has(groupId)
      })

    const getByDeviceType = (
      deviceType: HardwareDeviceType,
    ): Effect.Effect<readonly HardwareWalletMeta[], HardwareWalletStorageError> =>
      Effect.gen(function* () {
        const map = yield* loadCache()
        return Array.from(map.values()).filter((meta) => meta.deviceType === deviceType)
      })

    return {
      store,
      get,
      list,
      update,
      remove,
      isHardwareWallet,
      getByDeviceType,
    }
  })

/**
 * HardwareWalletStorage layer (requires Storage).
 */
export const HardwareWalletStorageLayer = Layer.effect(HardwareWalletStorage, createHardwareWalletStorage())
