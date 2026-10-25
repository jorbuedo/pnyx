/**
 * The UTxO plumbing shared by every swap-rail build — a market swap, an order
 * cancellation, a limit-order place or close.
 *
 * Extracted from `useSwapExecution` when the cancel flow needed the same
 * pieces. Duplicating them would have meant two coin selections drifting
 * apart, and a copy inside a hook cannot be tested without a React tree; here
 * it is plain functions over plain values.
 *
 * @module
 */

import type {UTxO} from '@evolution-sdk/evolution'
import {Assets, Bytes, CBOR, TransactionHash, TransactionInput, TxOut} from '@evolution-sdk/evolution'
import type {TxHashHex} from '@evolution-sdk/review/Brands'
import type {ResolvedInput} from '@pnyx/tx-review'
import {utxoId} from '@pnyx/wallet'
import {utxoAddressHex, utxoAssetMap, utxoTokenCount} from '../cardano/utxo-view'

/** Hard cap on UTxOs handed to the SteelSwap solver (payload + solver cost). */
export const MAX_BUILD_UTXOS = 25

export const isAdaId = (id: string): boolean => id === '' || id === '.'
export const isPureAda = (u: UTxO.UTxO): boolean => utxoTokenCount(u) === 0

/**
 * A UTxO's OWN address as hex. Account-level (watch-only) wallets spread UTxOs across many
 * addresses, so encoding them all under the primary address would make the solver reject them.
 *
 * ⚠️ Re-exported from the shared accessor rather than derived here. This used to render the typed
 * address to bech32, parse the bech32 back to hex, and fall back to the primary address when that
 * parse failed — a fallback for a failure that cannot happen once the `UTxO` carries a typed
 * `Address`. The `fallbackHex` parameter went with it, through `utxoToCip30Hex` and
 * `walletUtxoToResolvedInput` and their callers.
 */
export {utxoAddressHex} from '../cardano/utxo-view'

/**
 * Encode a held UTxO as a CIP-30 `TransactionUnspentOutput` hex for the solver.
 *
 * ⚠️ `encodingFormat: 'babbage'` is load-bearing: Conway accepts both output shapes, Evolution
 * defaults to the Shelley array, and the solver is shown the bytes the wallet would sign.
 *
 * ⚠️ `isAdaId` treats both `''` and `'.'` as lovelace; the bag keys only the real assets, so the
 * ADA sentinels are filtered out rather than handed to `Assets.fromRecord` as a policy id.
 */
export const utxoToCip30Hex = (utxo: UTxO.UTxO): string => {
  const input = TransactionInput.toCBORBytes(
    new TransactionInput.TransactionInput({
      transactionId: TransactionHash.fromHex(utxoId(utxo).split(':')[0] as TxHashHex),
      index: BigInt(Number(utxo.index)),
    }),
  )
  const assets = [...utxoAssetMap(utxo)].filter(([id]) => !isAdaId(id))
  const output = TxOut.toCBORBytes(
    new TxOut.TransactionOutput({
      address: utxo.address,
      assets: Assets.fromRecord({lovelace: utxo.assets.lovelace, ...Object.fromEntries(assets)}),
      encodingFormat: 'babbage',
    }),
  )
  // `transaction_unspent_output = [ transaction_input, transaction_output ]`.
  return Bytes.toHex(CBOR.encodeArrayAsDefinite([input, output]))
}

export const walletUtxoToResolvedInput = (
  utxo: UTxO.UTxO,
  unconfirmedTxHashes: ReadonlySet<string>,
): ResolvedInput => ({
  txHashHex: utxoId(utxo).split(':')[0] as TxHashHex,
  index: Number(utxo.index),
  addressHex: utxoAddressHex(utxo),
  coin: utxo.assets.lovelace,
  tokens: [...utxoAssetMap(utxo)].map(([assetId, amount]) => {
    const [policyIdHex = '', assetNameHex = ''] = assetId.split('.')
    return {policyIdHex, assetNameHex, amount}
  }),
  ...(unconfirmedTxHashes.has(utxoId(utxo).split(':')[0] as TxHashHex) ? {fromUnconfirmedTx: true} : {}),
})

/**
 * Pick a MINIMAL covering UTxO set for a swap-rail build.
 *
 * The aggregator does its own coin selection from whatever we hand it, and
 * passing the whole set (or big token-dense UTxOs) makes the solver crawl. So:
 * cover the input token with the fewest UTxOs holding it, then top up ADA with
 * pure-ADA UTxOs, largest first — ideally one.
 *
 * `adaHeadroom` is the margin over the ADA leg for batcher fee, deposit and
 * collateral.
 */
export const selectSwapUtxos = (
  spendable: readonly UTxO.UTxO[],
  opts: {
    readonly inputAssetId: string
    readonly inputAmount: bigint
    readonly adaHeadroom?: bigint
  },
): readonly UTxO.UTxO[] => {
  const inputIsAda = isAdaId(opts.inputAssetId)
  const adaNeed = (inputIsAda ? opts.inputAmount : 0n) + (opts.adaHeadroom ?? 15_000_000n)
  const tokenNeed = inputIsAda ? 0n : opts.inputAmount

  const selected: UTxO.UTxO[] = []
  const take = (u: UTxO.UTxO) => {
    if (!selected.includes(u)) selected.push(u)
  }
  const heldOf = (u: UTxO.UTxO) => utxoAssetMap(u)?.get(opts.inputAssetId) ?? 0n

  if (!inputIsAda) {
    let tok = 0n
    for (const u of [...spendable].filter((u) => heldOf(u) > 0n).sort((a, b) => (heldOf(b) > heldOf(a) ? 1 : -1))) {
      if (tok >= tokenNeed) break
      take(u)
      tok += heldOf(u)
    }
  }
  let ada = selected.reduce((s, u) => s + u.assets.lovelace, 0n)
  for (const u of [...spendable].filter(isPureAda).sort((a, b) => (b.assets.lovelace > a.assets.lovelace ? 1 : -1))) {
    if (ada >= adaNeed || selected.length >= MAX_BUILD_UTXOS) break
    take(u)
    ada += u.assets.lovelace
  }
  return selected
}
