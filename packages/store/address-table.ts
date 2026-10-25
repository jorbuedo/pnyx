/**
 * Addresses table — list-shaped, indexed storage for the wallet's derived
 * receive / change / single addresses across every chain and account.
 *
 * Lifted out of `WalletSnapshot.addresses` so:
 *  - CIP-30 `getUsedAddresses` / `getUnusedAddresses` are SQL filters, not
 *    JS walks over a ~thousand-derivative array (legacy-era multiaddress
 *    wallets routinely accumulate hundreds-to-thousands of used receive
 *    addresses, one per historical tx).
 *  - The cross-wallet airdrop / NIGHT-redeem scan reads via a single
 *    `(chainId, isUsed)` index across every wallet group, instead of
 *    loading + parsing every snapshot blob.
 *  - Send-flow mine-set lookups, signing-path resolution, and TxReview
 *    address-set construction don't pay a full snapshot reparse per access.
 *
 * Mirrors the design of the transactions and UTXOs tables — same
 * `Store` ↔ `Table` separation, same schema-versioning model.
 *
 * Adapters:
 *  - {@link ExpoSQLiteAddressTable} – native (iOS / Android) via expo-sqlite
 *  - {@link IndexedDBAddressTable}  – web / extension via IndexedDB
 *  - {@link MemoryAddressTable}     – in-process for tests
 *
 * @module
 */

import {Context, type Effect} from 'effect'
import type {StoreErrors} from './errors.js'

/**
 * Schema version for the addresses table.
 *
 * Bumped whenever the row shape, column set, or indexes change. On open,
 * adapters compare against the stored value and DROP+RECREATE on mismatch.
 * Chain-sync repopulates on next wallet load. Snapshots/checkpoints in the
 * KV store are untouched.
 */
export const ADDRESS_TABLE_SCHEMA_VERSION = 1

/**
 * Identity reference for a chain wallet's address set.
 *
 * Mirrors `UtxoRef` / `TxRef`. Duplicated here so the store package stays
 * free of wallet-package imports.
 */
export type AddressRef = {
  readonly groupId: string
  readonly chainId: string
  readonly accountIndex: number
}

/**
 * Derivation branch.
 *
 * CIP-1852 / BIP-44 receive role (`external`) and change role (`internal`)
 * for multi-address chains; `single` for chains that derive one canonical
 * address per account (EVM, Solana, single-address Bitcoin). A given
 * `(groupId, chainId, accountIndex)` is either `single` xor
 * `external`/`internal` — never mixed.
 */
export type AddressBranch = 'external' | 'internal' | 'single'

/**
 * A single row in the addresses table.
 *
 * Composite primary key is `(groupId, chainId, accountIndex, branch, index)`
 * — the natural identity of a derived address. Upserts replace by this key.
 *
 * `hash` carries the payment-key-hash credential on Cardano; on other
 * chains it equals `human` (no separate credential layer). `isUsed`
 * indicates the address has been observed on-chain — flipped to `true` by
 * chain-sync, never back to `false`.
 */
export type AddressRow = AddressRef & {
  readonly branch: AddressBranch
  readonly index: number
  readonly human: string
  readonly hash: string
  readonly isUsed: boolean
}

/**
 * Query parameters for {@link AddressTable.list} / {@link AddressTable.count}.
 *
 * All fields are optional so callers can ask:
 *  - per-wallet:  `{groupId, chainId, accountIndex}`
 *  - per-branch:  `{groupId, chainId, accountIndex, branch}`
 *  - cross-wallet scan:  `{chainId, isUsed: true}`
 *
 * Backed by indexes; see the per-adapter implementations.
 */
export type AddressListQuery = {
  readonly groupId?: string
  readonly chainId?: string
  readonly accountIndex?: number
  readonly branch?: AddressBranch
  readonly isUsed?: boolean
}

/**
 * Addresses table interface.
 *
 * Methods take a {@link AddressRef} (or unscoped {@link AddressListQuery})
 * so a single table instance serves every (group, chain, account) tuple —
 * the underlying storage is partitioned by those columns + indexed.
 *
 * Writes:
 *  - `upsert` / `upsertMany` replace by `(group, chain, account, branch, index)`.
 *    Address sets are append-mostly: chain-sync derives new entries past
 *    the gap limit and flips `isUsed` on a subset; rows never disappear.
 *    There is no `replaceAll` — re-derivation reuses existing rows.
 *  - `clear` wipes the partition (account delete, schema bump, wallet
 *    delete).
 *
 * Reads:
 *  - `list` returns rows matching {@link AddressListQuery}. Use the
 *    `(chainId, isUsed)` index for cross-wallet scans, the
 *    `(group_id, chain_id, account_index, branch, is_used)` index for
 *    per-wallet filters.
 *  - `get` is a point lookup by `(ref, branch, index)`.
 *  - `count` returns the row count without materializing rows.
 *
 * Lifecycle:
 *  - `close` releases the underlying database/connection.
 */
export type AddressTable = {
  readonly upsert: (row: AddressRow) => Effect.Effect<void, StoreErrors>
  readonly upsertMany: (rows: ReadonlyArray<AddressRow>) => Effect.Effect<void, StoreErrors>
  readonly list: (query: AddressListQuery) => Effect.Effect<ReadonlyArray<AddressRow>, StoreErrors>
  readonly get: (ref: AddressRef, branch: AddressBranch, index: number) => Effect.Effect<AddressRow | null, StoreErrors>
  readonly count: (query: AddressListQuery) => Effect.Effect<number, StoreErrors>
  readonly clear: (ref: AddressRef) => Effect.Effect<void, StoreErrors>
  readonly close: () => Effect.Effect<void, StoreErrors>
}

/**
 * Effect Service tag for dependency injection.
 */
export class AddressTableService extends Context.Tag('AddressTableService')<AddressTableService, AddressTable>() {}
