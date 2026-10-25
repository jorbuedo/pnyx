/**
 * CIP-30 `getUtxos(amount)` target parsing + greedy UTxO selection.
 *
 * Per CIP-30 `amount` is `cbor<value>` hex; a bare decimal lovelace string is
 * also accepted for reference-connector compatibility. Selection is greedy in
 * wallet order, skipping UTxOs that contribute nothing to an unmet need, and
 * returns `null` when the wallet cannot cover the request (the CIP-30 contract).
 *
 * @see https://cips.cardano.org/cip/CIP-0030#getutxosamount-cborvalue-paginate-paginate--transactionunspentoutput--null
 * @module
 */

import {CborError} from '@evolution-sdk/review/Errors'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {Effect} from 'effect'

/** A wallet UTxO in structured form (the handler context's shape). */
export type CardanoUtxo = {
  readonly txHashHex: string
  readonly index: number
  /** Raw address bytes, hex. */
  readonly addressHex: string
  readonly coin: bigint
  readonly assets: readonly {readonly policyHex: string; readonly nameHex: string; readonly quantity: bigint}[]
}

/** A parsed target: coin plus per-asset needs keyed `"<policyHex>.<nameHex>"`. */
export type ValueTarget = {
  readonly coin: bigint
  readonly assets: ReadonlyMap<string, bigint>
}

const DECIMAL_LOVELACE = /^\d+$/

/**
 * Cap on distinct assets in a dApp-controlled target — an uncapped
 * multi-thousand-asset value is a cheap CPU-amplification vector.
 */
export const MAX_TARGET_ASSETS = 1000

const assetKey = (policyHex: string, nameHex: string): string => `${policyHex}.${nameHex}`

/** Parse a CIP-30 `amount` (cbor<value> hex, or bare decimal lovelace). */
export const parseValueTarget = (amount: string): Effect.Effect<ValueTarget, CborError> => {
  if (DECIMAL_LOVELACE.test(amount)) {
    return Effect.succeed({coin: BigInt(amount), assets: new Map()})
  }
  return Inspect.value(amount).pipe(
    Effect.flatMap((view) => {
      if (view.tokens.length > MAX_TARGET_ASSETS) {
        return Effect.fail(new CborError({message: `getUtxos target exceeds ${MAX_TARGET_ASSETS} distinct assets`}))
      }
      const assets = new Map<string, bigint>()
      for (const token of view.tokens) {
        const key = assetKey(token.policyIdHex, token.assetNameHex)
        assets.set(key, (assets.get(key) ?? 0n) + token.amount)
      }
      return Effect.succeed({coin: view.amount, assets})
    }),
  )
}

const contributes = (utxo: CardanoUtxo, remaining: ReadonlyMap<string, bigint>): boolean => {
  for (const asset of utxo.assets) {
    if ((remaining.get(assetKey(asset.policyHex, asset.nameHex)) ?? 0n) > 0n) return true
  }
  return false
}

/**
 * Greedily select UTxOs (wallet order) covering `target`; `null` when the
 * wallet cannot satisfy it. Unmet-asset count is tracked incrementally so a
 * dApp-controlled target cannot force a re-scan per selected UTxO.
 */
export const selectUtxosForTarget = (
  utxos: readonly CardanoUtxo[],
  target: ValueTarget,
): readonly CardanoUtxo[] | null => {
  let coinNeeded = target.coin
  const assetsNeeded = new Map(target.assets)
  let unmetAssets = 0
  for (const quantity of assetsNeeded.values()) if (quantity > 0n) unmetAssets++
  const satisfied = (): boolean => coinNeeded <= 0n && unmetAssets === 0

  const selected: CardanoUtxo[] = []
  if (satisfied()) return selected

  for (const utxo of utxos) {
    if (coinNeeded <= 0n && !contributes(utxo, assetsNeeded)) continue
    selected.push(utxo)
    coinNeeded -= utxo.coin
    for (const asset of utxo.assets) {
      const key = assetKey(asset.policyHex, asset.nameHex)
      const remaining = assetsNeeded.get(key)
      if (remaining !== undefined) {
        const next = remaining - asset.quantity
        assetsNeeded.set(key, next)
        if (remaining > 0n && next <= 0n) unmetAssets--
      }
    }
    if (satisfied()) return selected
  }
  return null
}
