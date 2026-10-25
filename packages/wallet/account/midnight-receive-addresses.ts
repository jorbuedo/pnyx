/**
 * Midnight receive-address persistence.
 *
 * Midnight receive addresses derive from role *secret* keys (see
 * `./derivation/midnight.ts`) — there is no xpub-only derivation — so the
 * xpub-based `AddressGenerator` contract can never produce them. Instead they
 * are derived exactly once, at wallet-creation time while the mnemonic is in
 * memory, and persisted in the address table. Receive-address reads then serve
 * from storage; nothing re-derives on read.
 *
 * Row layout: Midnight is a single-address chain per account, so all rows live
 * under `branch: 'single'` in the wallet's `(groupId, chainId, accountIndex)`
 * partition, with a fixed index slot per address kind — night at 0 (the
 * canonical receive/identity address, the `single`/0 slot every receive-address
 * read expects), dust at 1, shielded at 2. `hash` equals `human` (no separate
 * credential layer on Midnight).
 *
 * ⚠️ **The `chainId` of these rows carries the Midnight network** — see
 * {@link midnightAddressStoreKey}. An address's bech32m HRP is fixed at
 * derivation time (`mn_addr1…` on mainnet, `mn_addr_preprod1…` on preprod), so a
 * row is only valid for the network it was derived for, and the key has to say
 * which. This is a *storage* key, not the app's chain id: the wallet still
 * treats Midnight as one chain (`MIDNIGHT_MAINNET`) everywhere else.
 *
 * These rows therefore belong in a **network-independent** store. They are
 * derivation output, not chain observation, and the whole set is known from the
 * seed at creation — so all networks are written at once and a later network
 * switch finds its rows already there. Keeping them in a per-network database
 * instead lost them on every switch, permanently, because nothing re-derives on
 * read (see `docs/STORAGE_MIGRATIONS.md`).
 *
 * @module
 */

import type {AddressRef, AddressRow} from '@pnyx/store/address-table'
import type {StoreErrors} from '@pnyx/store/errors'
import {Effect} from 'effect'
import {DerivationError} from '../errors.js'
import type {Network} from '../types.js'
import {
  deriveMidnightReceiveAddressesFromMnemonic,
  type MidnightNetworkId,
  type MidnightReceiveAddresses,
} from './derivation/midnight.js'

/**
 * Fixed `branch: 'single'` index slot per Midnight address kind.
 * Slot 0 is load-bearing: generic receive-address reads resolve `single`/0.
 */
export const MIDNIGHT_RECEIVE_ADDRESS_SLOTS = {
  night: 0,
  dust: 1,
  shielded: 2,
} as const

/**
 * Map the wallet's network to the Midnight bech32m network segment.
 *
 * Identity, because all three of our network names are also Midnight network ids
 * (`NetworkId` in `@midnight-ntwrk/wallet-sdk-abstractions`: mainnet, testnet, devnet,
 * qanet, undeployed, preview, preprod). `mainnet` still gets no segment — that rule
 * lives in the encoder.
 *
 * ⚠️ This used to collapse both non-mainnet networks to `testnet`, on the belief that
 * Midnight had a single testnet. It does not, and the mismatch was not cosmetic: the
 * preprod indexer refuses an `mn_addr_testnet…` address outright — *"expected HRP
 * mn_addr_preprod"* — so every Midnight address the app showed on preprod was one no
 * other tool on that chain would accept, and `unshieldedTransactions` could not be
 * subscribed for it. The node names itself `Midnight Preprod`, and
 * `midnightFundsNetwork` already resolved preprod → preprod; this was the mirror that
 * disagreed.
 */
export const midnightNetworkIdForNetwork = (network: Network): MidnightNetworkId => network

/**
 * The address-table `chainId` a Midnight network's rows live under.
 *
 * A *storage* key, deliberately distinct from the app's `MIDNIGHT_MAINNET` chain
 * id: the wallet treats Midnight as a single chain, but an address's HRP is fixed
 * when it is derived, so one row per network is the only correct shape. Reads
 * resolve the current network's key; writes cover every network the build knows.
 */
export const midnightAddressStoreKey = (networkId: MidnightNetworkId): string => `midnight:${networkId}`

/**
 * Shape a derived {@link MidnightReceiveAddresses} set into address-table rows
 * following the slot layout documented at module level.
 */
export const midnightReceiveAddressRows = (
  ref: AddressRef,
  addresses: MidnightReceiveAddresses,
): readonly AddressRow[] =>
  (['night', 'dust', 'shielded'] as const).map((kind) => ({
    ...ref,
    branch: 'single' as const,
    index: MIDNIGHT_RECEIVE_ADDRESS_SLOTS[kind],
    human: addresses[kind],
    hash: addresses[kind],
    isUsed: false,
  }))

/**
 * The address-table surface this module needs — the `AddressTable` method names,
 * because these rows live in their own table rather than the wallet data store.
 */
export type MidnightAddressStore = {
  readonly get: (
    ref: AddressRef,
    branch: 'external' | 'internal' | 'single',
    index: number,
  ) => Effect.Effect<AddressRow | null, StoreErrors>
  readonly upsertMany: (rows: readonly AddressRow[]) => Effect.Effect<void, StoreErrors>
}

/**
 * Derive the wallet's Midnight receive addresses from the mnemonic and persist
 * them, one set per network in `networkIds`.
 *
 * Every network is written in the one call that holds the mnemonic, because a
 * later network switch has no seed to derive from and nothing re-derives on read.
 * Per-network idempotent: a network whose canonical `single`/0 row already exists
 * is skipped, so a retry, an add-chain on an upgraded group, a restore on the same
 * device, or a backfill that only some networks need all do the minimum work.
 *
 * `ref.chainId` is ignored — the key comes from {@link midnightAddressStoreKey} —
 * so a caller cannot accidentally file one network's addresses under another's.
 */
export const persistMidnightReceiveAddresses = (params: {
  readonly store: MidnightAddressStore
  readonly ref: AddressRef
  readonly mnemonic: string
  readonly networkIds: readonly MidnightNetworkId[]
}): Effect.Effect<readonly MidnightNetworkId[], DerivationError | StoreErrors> =>
  Effect.gen(function* () {
    const {store, ref, mnemonic, networkIds} = params
    const written: MidnightNetworkId[] = []

    for (const networkId of networkIds) {
      const scoped = {...ref, chainId: midnightAddressStoreKey(networkId)}
      const existing = yield* store.get(scoped, 'single', MIDNIGHT_RECEIVE_ADDRESS_SLOTS.night)
      if (existing !== null) continue

      const addresses = yield* deriveMidnightReceiveAddressesFromMnemonic(mnemonic, {
        account: ref.accountIndex,
        networkId,
      })
      yield* store.upsertMany(midnightReceiveAddressRows(scoped, addresses))
      written.push(networkId)
    }

    return written
  })

/**
 * Read a stored Midnight receive address for `networkId` — by default the
 * canonical night (`single`/0) row; pass a {@link MIDNIGHT_RECEIVE_ADDRESS_SLOTS}
 * slot for the dust or shielded address. Fails with a typed
 * {@link DerivationError} when nothing is stored — re-derivation needs the seed,
 * so callers must not fall back to an xpub path.
 *
 * A miss means this network was never written (a wallet created before the rows
 * were network-keyed), not that the wallet has no Midnight addresses. It is
 * repaired by {@link persistMidnightReceiveAddresses} at the next point a
 * mnemonic is in hand, not by anything here.
 */
export const getStoredMidnightReceiveAddress = (
  store: Pick<MidnightAddressStore, 'get'>,
  ref: AddressRef,
  networkId: MidnightNetworkId,
  slot: number = MIDNIGHT_RECEIVE_ADDRESS_SLOTS.night,
): Effect.Effect<string, DerivationError | StoreErrors> =>
  Effect.gen(function* () {
    const row = yield* store.get({...ref, chainId: midnightAddressStoreKey(networkId)}, 'single', slot)
    if (row === null || row.human.length === 0) {
      return yield* Effect.fail(
        new DerivationError({
          message: `Midnight receive address not stored for ${networkId} — it derives from the seed and cannot be re-derived from an xpub`,
        }),
      )
    }
    return row.human
  })
