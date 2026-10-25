/**
 * Pure planning for UTxO consolidation: which UTxOs to fold, and how to shape
 * the outputs they fold into.
 *
 * Deliberately does **not** decide how many inputs fit in one transaction. That
 * bound is the serialized byte count, which is only knowable after assembly, so
 * the build loop settles it with `Plan.fitBySize`. What lives here is everything
 * decidable without building: partitioning the set, grouping assets, and honouring
 * the user's optimization policy.
 *
 * The two protocol bounds pull in opposite directions and that is the whole
 * problem. Folding more inputs shrinks the UTxO set but grows the transaction;
 * folding more assets into one output shrinks the output count but grows that
 * output's value past `maxValueSize`. Consolidation is only worth doing when it
 * strictly reduces the set, so a plan that would produce as many outputs as it
 * consumes inputs is no plan at all.
 *
 * @module
 */

import type {UTxO} from '@evolution-sdk/evolution'
import type {Plan} from '@evolution-sdk/plan'
import {utxoId} from '@pnyx/wallet'
import {utxoAssetMap, utxoTokenCount} from '../utxo-view'
import type {WalletOptimization} from './policy'

/** A UTxO carrying no native assets — the cheapest possible input. */
export const isPureAda = (utxo: UTxO.UTxO): boolean => utxoTokenCount(utxo) === 0

/** Every asset across `utxos`, summed by asset id. */
export const totalAssets = (utxos: readonly UTxO.UTxO[]): readonly Plan.AssetAmount[] => {
  const totals = new Map<string, bigint>()
  for (const utxo of utxos) {
    for (const [assetId, amount] of utxoAssetMap(utxo)) {
      totals.set(assetId, (totals.get(assetId) ?? 0n) + amount)
    }
  }
  return [...totals.entries()].map(([assetId, amount]) => ({assetId, amount}))
}

/** Total lovelace across `utxos`. */
export const totalLovelace = (utxos: readonly UTxO.UTxO[]): bigint =>
  utxos.reduce((sum, utxo) => sum + utxo.assets.lovelace, 0n)

/**
 * Order assets so that ones sharing a policy sit together.
 *
 * A `Value` groups assets under their policy id, so adjacency is what lets the
 * packer fill an output densely — the same twenty assets cost markedly less under
 * one policy than spread across two. With `bundleByPolicy` off, the original
 * order is preserved so grouping follows whatever the caller already had.
 */
export const orderAssetsForPacking = (
  assets: readonly Plan.AssetAmount[],
  policy: Pick<WalletOptimization, 'bundleByPolicy'>,
): readonly Plan.AssetAmount[] => {
  if (!policy.bundleByPolicy) return assets
  return [...assets].sort((a, b) => {
    const [pa = ''] = a.assetId.split('.')
    const [pb = ''] = b.assetId.split('.')
    if (pa !== pb) return pa < pb ? -1 : 1
    return a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0
  })
}

export type ConsolidationCandidates = {
  /**
   * UTxOs worth folding, in the order they should be offered to the size fitter:
   * pure-ADA first, because they are the densest inputs per byte and consolidating
   * them is what unblocks a stuck send.
   */
  readonly candidates: readonly UTxO.UTxO[]
  /**
   * Left out on purpose, with the reason. Never silently dropped — a user who
   * asked to consolidate and got a partial result has to be able to see why.
   */
  readonly excluded: readonly {readonly utxo: UTxO.UTxO; readonly reason: ExclusionReason}[]
}

export type ExclusionReason =
  /** Held back so at least one token-free UTxO survives (`keepPureAdaOutput`). */
  | 'reserved-pure-ada'
  /** Beyond the user's per-transaction input cap. */
  | 'over-input-cap'
  /**
   * The wallet holds no key that can witness it — a script-locked UTxO sitting
   * under our stake credential. Not a policy choice: including it would build a
   * transaction nothing can sign.
   */
  | 'not-spendable'

/**
 * Choose which UTxOs to fold.
 *
 * Consolidation needs at least two inputs to be meaningful, and `keepPureAdaOutput`
 * means holding one token-free UTxO back rather than sweeping the wallet into a
 * single asset-laden output that every later send has to drag around.
 */
export const selectConsolidationCandidates = (
  utxos: readonly UTxO.UTxO[],
  policy: WalletOptimization,
): ConsolidationCandidates => {
  const pure = utxos.filter(isPureAda)
  const withAssets = utxos.filter((u) => !isPureAda(u))
  const excluded: {utxo: UTxO.UTxO; reason: ExclusionReason}[] = []

  // Hold back the largest pure-ADA UTxO: reserving the biggest keeps the most
  // useful cheap input, and reserving the smallest would leave dust behind.
  let reserved: UTxO.UTxO | undefined
  if (policy.keepPureAdaOutput && pure.length > 0) {
    reserved = pure.reduce((best, u) => (u.assets.lovelace > best.assets.lovelace ? u : best), pure[0] as UTxO.UTxO)
    excluded.push({utxo: reserved, reason: 'reserved-pure-ada'})
  }

  const reservedId = reserved === undefined ? null : utxoId(reserved)
  const ordered = [...pure.filter((u) => utxoId(u) !== reservedId), ...withAssets]

  const cap = policy.maxInputsPerTx
  if (cap !== undefined && ordered.length > cap) {
    for (const utxo of ordered.slice(cap)) excluded.push({utxo, reason: 'over-input-cap'})
    return {candidates: ordered.slice(0, cap), excluded}
  }
  return {candidates: ordered, excluded}
}

/**
 * Whether folding `inputCount` UTxOs into `outputCount` outputs is worth a fee.
 *
 * Consolidation exists to shrink the set. Producing as many outputs as it
 * consumes inputs shrinks nothing and still costs a fee, so it must not be
 * offered — which is a real outcome for a wallet whose assets are spread across
 * enough policies that every output fills up.
 */
export const reducesUtxoCount = (inputCount: number, outputCount: number): boolean =>
  inputCount >= 2 && outputCount < inputCount
