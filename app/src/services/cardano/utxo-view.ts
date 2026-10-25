/**
 * Reading a UTxO the way a display or a wire response needs it.
 *
 * ⚠️ **These exist for the SERIALIZED and EDGE zones only.** The Cardano UTxO path carries
 * Evolution's `UTxO` in memory (2026-10-10), so compute — coin selection, min-ADA, fee
 * convergence, anything handing a bag to the plan engine — passes `utxo.assets` straight through
 * and must not come here. What does come here: a screen listing tokens, a CIP-30 response, a
 * review row, a persisted snapshot. Those genuinely need the string spelling, because the string
 * IS their format.
 *
 * ⚠️⚠️ **The spelling is `policy.name`, with a DOT, and it is decided here once.** Evolution's
 * `Assets.getUnits` emits the JOINED form (`policyId + assetName`), while every stored row, every
 * intent and every `remainderAssets` comparison in this app is keyed on the dotted one. The two
 * are both `string`, so mixing them answers `0n` rather than failing — which is why there is one
 * function rather than thirty call sites each doing their own `split('.')`.
 *
 * @module
 */

import {Assets as EvAssets, Address as EvolutionAddress, TransactionHash, type UTxO} from '@evolution-sdk/evolution'

/** `policy.name` → quantity. Empty when the UTxO holds only lovelace. The name half may be empty: that is a real asset name. */
export const utxoAssetMap = (utxo: UTxO.UTxO): ReadonlyMap<string, bigint> => {
  const out = new Map<string, bigint>()
  const multiAsset = utxo.assets.multiAsset
  if (multiAsset === undefined) return out
  for (const [policy, names] of multiAsset.map.entries()) {
    for (const [name, quantity] of names.entries()) {
      out.set(`${bytesToHex(policy.hash)}.${bytesToHex(name.bytes)}`, quantity)
    }
  }
  return out
}

const bytesToHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** How many distinct tokens the UTxO holds. Cheaper than building the map to ask its size. */
export const utxoTokenCount = (utxo: UTxO.UTxO): number =>
  EvAssets.hasOnlyLovelace(utxo.assets) ? 0 : utxoAssetMap(utxo).size

/**
 * ⚠️ `hasOnlyLovelace`, never `hasMultiAsset`: the latter answers true for a bag whose only token
 * is zero, and a bag can hold a zero after a subtract.
 */
export const utxoIsAdaOnly = (utxo: UTxO.UTxO): boolean => EvAssets.hasOnlyLovelace(utxo.assets)

/** The UTxO's address as bech32 — what a screen shows and a stored row keys on. */
export const utxoAddressBech32 = (utxo: UTxO.UTxO): string => EvolutionAddress.toBech32(utxo.address)

/** The transaction id as lowercase hex. Persisted and compared, so the case is part of the format. */
export const utxoTxHashHex = (utxo: UTxO.UTxO): string => TransactionHash.toHex(utxo.transactionId)

/**
 * The address as raw hex — the CIP-30 wire form, and what a review's resolved input carries.
 *
 * ⚠️ Straight from the typed address. Three call sites used to reach this by rendering
 * {@link utxoAddressBech32} and parsing the bech32 back, which is two conversions to produce
 * bytes the `UTxO` already holds — and a parse that could fail, on a value that cannot.
 */
export const utxoAddressHex = (utxo: UTxO.UTxO): string => EvolutionAddress.toHex(utxo.address)
