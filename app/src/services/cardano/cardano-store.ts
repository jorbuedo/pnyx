/**
 * Bridge between the Cardano rail and the persisted `@pnyx/store` wallet data
 * store — so the rail can write confirmed UTxOs + the sync watermark on sync and
 * hydrate them on cold start (storage-first, see `docs/CARDANO_DATA_SYNC.md`).
 *
 * The store instance is bound once at app init (`setCardanoDataStore`, called
 * from `wallet-service`). When unset — tests, or before init — the rail simply
 * skips persistence and behaves exactly as before (in-memory only).
 *
 * @module
 */

import {Assets as EvAssets, Address as EvolutionAddress, TransactionHash, UTxO} from '@evolution-sdk/evolution'
import type {ChainId} from '@pnyx/config'
import type {StoredBalances, WalletDataStore, WalletGroupId, WalletSnapshot} from '@pnyx/wallet'
import {WALLET_SNAPSHOT_VERSION} from '@pnyx/wallet'
import type {SyncWatermark} from './sync-decision'
import {utxoAddressBech32, utxoAssetMap, utxoTxHashHex} from './utxo-view'

/**
 * Identity of a Cardano wallet's persisted data (one account per group for now).
 * `chainId` is the canonical Cardano CAIP-2 id (`cardanoChainIdFor`); `groupId`
 * is branded so the ref is assignable to both the store's `DataRef`
 * (snapshot/checkpoint) and the plain `UtxoRef` (utxo-table).
 */
export type CardanoDataRef = {
  readonly groupId: WalletGroupId
  readonly chainId: ChainId
  readonly accountIndex: number
}

export const cardanoDataRef = (groupId: string, chainId: ChainId, accountIndex = 0): CardanoDataRef => ({
  groupId: groupId as WalletGroupId,
  chainId,
  accountIndex,
})

// ── module-level store binding ────────────────────────────────────────────────

let dataStore: WalletDataStore | null = null

/** Bind the persisted wallet data store. Called once at app init. */
export const setCardanoDataStore = (store: WalletDataStore): void => {
  dataStore = store
}

/** The bound store, or `null` when persistence isn't initialized (tests / pre-init). */
export const getCardanoDataStore = (): WalletDataStore | null => dataStore

/** Clear the binding (tests). */
export const clearCardanoDataStore = (): void => {
  dataStore = null
}

// ── pure row mappers ────────────────────────────────────────────────────────

/** A persisted UTxO row (the `@pnyx/store` utxo-table shape, ref fields spread in). */
export type CardanoUtxoRow = CardanoDataRef & {
  readonly txHash: string
  readonly txIndex: number
  readonly address: string
  readonly quantity: string
  readonly assets: ReadonlyArray<{readonly id: string; readonly quantity: string}>
}

/**
 * `UTxO` → persisted row. Lovelace + asset quantities become decimal strings.
 *
 * ⚠️ **This is the serialized edge.** Every field a row carries is a string or a number because
 * that is the storage format; the in-memory value is Evolution's `UTxO`, and the conversion happens
 * exactly here and in {@link rowToUtxo}. The asset spelling comes from `utxoAssetMap`, which owns
 * the dotted form.
 */
export const utxoToRow = (ref: CardanoDataRef, u: UTxO.UTxO): CardanoUtxoRow => ({
  ...ref,
  txHash: utxoTxHashHex(u),
  txIndex: Number(u.index),
  address: utxoAddressBech32(u),
  quantity: u.assets.lovelace.toString(),
  assets: [...utxoAssetMap(u)].map(([id, quantity]) => ({id, quantity: quantity.toString()})),
})

/** The value-bearing fields of a persisted UTxO row (ref fields are ignored on read). */
export type PersistedUtxoFields = {
  readonly txHash: string
  readonly txIndex: number
  readonly address: string
  readonly quantity: string
  readonly assets: ReadonlyArray<{readonly id: string; readonly quantity: string}>
}

/**
 * Persisted row → `UTxO`. Inverse of {@link utxoToRow}.
 *
 * ⚠️ **Throws on a row it cannot read, and that is the contract.** Evolution's `UTxO` validates on
 * construction — a bech32 that does not decode, a negative lovelace, a zero-quantity token — so a
 * row that cannot become a UTxO is one we must not pretend to have read. The caller logs and drops
 * it (see the rail's snapshot seeding); substituting a shape would put a wrong balance on screen,
 * which the Fallback Value Policy exists to prevent.
 */
export const rowToUtxo = (row: PersistedUtxoFields): UTxO.UTxO =>
  new UTxO.UTxO({
    transactionId: TransactionHash.fromHex(row.txHash),
    index: BigInt(row.txIndex),
    address: EvolutionAddress.fromBech32(row.address),
    assets: row.assets.reduce(
      (bag, a) => {
        const [policy = '', name = ''] = a.id.split('.')
        return EvAssets.addByHex(bag, policy, name, BigInt(a.quantity))
      },
      EvAssets.fromLovelace(BigInt(row.quantity)),
    ),
  })

/** Confirmed-UTxO balances for the persisted snapshot (portfolio cold-start render). */
export const snapshotBalancesOf = (utxos: readonly UTxO.UTxO[]): StoredBalances => {
  let lovelace = 0n
  const assets = new Map<string, bigint>()
  for (const u of utxos) {
    lovelace += u.assets.lovelace
    for (const [id, quantity] of utxoAssetMap(u)) assets.set(id, (assets.get(id) ?? 0n) + quantity)
  }
  return {
    primary: {id: '.', quantity: lovelace.toString()},
    secondary: [...assets.entries()].map(([id, quantity]) => ({id, quantity: quantity.toString()})),
  }
}

/** Build the persisted snapshot from confirmed UTxOs + the current sync watermark. */
export const buildCardanoSnapshot = (
  ref: CardanoDataRef,
  utxos: readonly UTxO.UTxO[],
  watermark: SyncWatermark,
  coverage: string,
): WalletSnapshot => ({
  version: WALLET_SNAPSHOT_VERSION,
  groupId: ref.groupId,
  chainId: ref.chainId,
  accountIndex: ref.accountIndex,
  balances: snapshotBalancesOf(utxos),
  // Only meaningful together: a watermark without the coverage that produced it cannot be
  // validated by the next reader, so neither is written alone.
  ...(watermark ? {syncWatermark: watermark, syncCoverage: coverage} : {}),
})
