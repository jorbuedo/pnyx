/**
 * Persistence bridge for Cardano tx history (storage-first, incremental — see
 * `docs/CARDANO_DATA_SYNC.md`). Confirmed txs are immutable, so once a tx is in
 * `@pnyx/store`'s tx-table we never refetch it: the history load renders the
 * stored rows and only pulls blocks newer than the newest stored one.
 *
 * A stored `TxRow` carries a list projection (direction/amount/…) plus an opaque
 * `detailJson` holding the full `IndexedCardanoTx`; the history screen renders
 * `ReviewedTransaction`, which is rebuilt from `detailJson` via
 * `reviewCardanoFromHistory` — no network, no screen change.
 *
 * @module
 */

import type {TxDirection, TxRow} from '@pnyx/store/tx-table'
import type {IndexedCardanoTx} from '@pnyx/tx-review'
import type {CardanoDataRef} from './cardano-store'

const ADA_SYMBOL = 'ADA'
const ADA_DECIMALS = 6

// ── bigint-safe JSON (detailJson holds an IndexedCardanoTx with bigint coins) ──

type BigintTag = {readonly $bigint: string}
const isBigintTag = (v: unknown): v is BigintTag =>
  typeof v === 'object' && v !== null && typeof (v as {$bigint?: unknown}).$bigint === 'string'

/** Serialize an `IndexedCardanoTx` to JSON, tagging every bigint as `{$bigint}`. */
export const serializeIndexedTx = (tx: IndexedCardanoTx): string =>
  JSON.stringify(tx, (_k, v) => (typeof v === 'bigint' ? {$bigint: v.toString()} : v))

/** Inverse of {@link serializeIndexedTx}: restores tagged bigints. */
export const deserializeIndexedTx = (json: string): IndexedCardanoTx =>
  JSON.parse(json, (_k, v) => (isBigintTag(v) ? BigInt(v.$bigint) : v)) as IndexedCardanoTx

// ── ownership-relative projection ──────────────────────────────────────────────

const NIGHT_ADA = '' // ADA has no asset id in the delta map; key '' is lovelace.

/** Signed asset deltas from the wallet's perspective (own outputs − own inputs). */
export type OwnershipDelta = {
  readonly direction: TxDirection
  /** Signed lovelace delta (negative = net spent). */
  readonly adaDelta: bigint
  /** Non-ADA net deltas by `policyIdHex.assetNameHex`, non-zero only. */
  readonly assetDeltas: ReadonlyMap<string, bigint>
  /** Other party: first non-own output (sent) / input (received), else null. */
  readonly counterparty: string | null
}

/**
 * "Is this address ours?" — a set of bech32 addresses, or a predicate.
 *
 * ⚠️ **A predicate exists because a set cannot always be written down.** A watch-only stake account can
 * have hundreds of thousands of addresses (measured: 490,000 for one with four funded), and enumerating
 * them cost 51 MB and killed the app. Where the account *is* the wallet, ownership is a credential fact
 * — every address of the account shares its stake credential — so it can be decided per address instead
 * of listed in advance.
 */
export type AddressOwnership = ReadonlySet<string> | ((addressBech32: string) => boolean)

const ownPredicate = (ownership: AddressOwnership): ((a: string) => boolean) =>
  typeof ownership === 'function' ? ownership : (a: string) => ownership.has(a)

/**
 * Derive the wallet-relative direction + deltas of an indexed tx. Pure — `ownership` is the wallet's own
 * bech32 addresses (payment + reward), or a predicate deciding the same question.
 */
export const ownershipDelta = (tx: IndexedCardanoTx, ownership: AddressOwnership): OwnershipDelta => {
  const own = ownPredicate(ownership)
  let adaDelta = 0n
  const assetDeltas = new Map<string, bigint>()
  const add = (id: string, q: bigint) => assetDeltas.set(id, (assetDeltas.get(id) ?? 0n) + q)

  for (const i of tx.inputs) {
    if (!own(i.addressBech32)) continue
    adaDelta -= i.coin
    for (const t of i.tokens) add(`${t.policyIdHex}.${t.assetNameHex}`, -t.amount)
  }
  for (const o of tx.outputs) {
    if (!own(o.addressBech32)) continue
    adaDelta += o.coin
    for (const t of o.tokens) add(`${t.policyIdHex}.${t.assetNameHex}`, t.amount)
  }
  for (const [id, q] of [...assetDeltas]) if (q === 0n) assetDeltas.delete(id)

  const ownInput = tx.inputs.some((i) => own(i.addressBech32))
  const ownOutputToExternal = tx.outputs.some((o) => !own(o.addressBech32))
  const direction: TxDirection = ownInput ? (ownOutputToExternal ? 'sent' : 'self') : 'received'

  const counterparty =
    direction === 'sent'
      ? (tx.outputs.find((o) => !own(o.addressBech32))?.addressBech32 ?? null)
      : direction === 'received'
        ? (tx.inputs.find((i) => !own(i.addressBech32))?.addressBech32 ?? null)
        : null

  return {direction, adaDelta, assetDeltas, counterparty}
}

/**
 * `IndexedCardanoTx` → persisted `TxRow`: the list projection (computed against
 * the wallet's own addresses) plus `detailJson` for lossless rebuild. Pure.
 */
export const indexedTxToRow = (ref: CardanoDataRef, tx: IndexedCardanoTx, ownership: AddressOwnership): TxRow => {
  const {direction, adaDelta, assetDeltas, counterparty} = ownershipDelta(tx, ownership)
  const timestamp = tx.time ? Math.floor(Date.parse(tx.time) / 1000) : null
  return {
    groupId: ref.groupId,
    chainId: ref.chainId,
    accountIndex: ref.accountIndex,
    hash: tx.hash,
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
    submittedAt: null,
    status: tx.valid === false ? 'failed' : 'confirmed',
    type: tx.certificates && tx.certificates.length > 0 ? 'certificate' : 'transfer',
    direction,
    amount: (adaDelta < 0n ? -adaDelta : adaDelta).toString(),
    fee: tx.fee.toString(),
    counterpartyAddress: counterparty,
    primaryAssetDelta: adaDelta.toString(),
    additionalAssetCount: assetDeltas.size,
    hasNft: false,
    assetSymbol: ADA_SYMBOL,
    assetDecimals: ADA_DECIMALS,
    iconUrl: null,
    tokenId: NIGHT_ADA === '' ? null : NIGHT_ADA,
    contractAddress: null,
    listMetaJson: null,
    detailJson: serializeIndexedTx(tx),
  }
}

/**
 * The `afterBlock` cursor for an incremental fetch: one below the newest stored
 * block height, so the boundary block is re-included and same-block stragglers
 * aren't missed (the merge dedupes by hash). `undefined` when nothing is stored
 * (⇒ a full initial fetch).
 */
export const afterBlockCursor = (storedTxs: readonly IndexedCardanoTx[]): number | undefined => {
  let max: number | undefined
  for (const tx of storedTxs) {
    if (tx.blockHeight !== undefined && (max === undefined || tx.blockHeight > max)) max = tx.blockHeight
  }
  return max === undefined ? undefined : Math.max(0, max - 1)
}

/** Merge new (newest-first) txs ahead of stored, dedupe by hash, keep newest-first. */
export const mergeByHash = <T extends {readonly hash?: string}>(
  fresh: readonly T[],
  stored: readonly T[],
): readonly T[] => {
  const seen = new Set<string>()
  const out: T[] = []
  for (const t of [...fresh, ...stored]) {
    const h = t.hash
    if (h === undefined) {
      out.push(t)
      continue
    }
    if (seen.has(h)) continue
    seen.add(h)
    out.push(t)
  }
  return out
}
