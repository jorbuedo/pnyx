/**
 * Pure bigint value arithmetic over asset maps. Keys are `assetId` strings
 * (`"<policyHex>.<assetNameHex>"`); the empty key is the chain coin.
 *
 * @module
 */

import type {ReviewedAmount} from './types.js'

export const COIN = ''

export type ValueMap = Map<string, bigint>

export const emptyValue = (): ValueMap => new Map()

export const addAmount = (value: ValueMap, assetId: string, quantity: bigint): void => {
  const next = (value.get(assetId) ?? 0n) + quantity
  if (next === 0n) value.delete(assetId)
  else value.set(assetId, next)
}

export const addValue = (target: ValueMap, source: ValueMap, sign: 1n | -1n = 1n): void => {
  for (const [assetId, quantity] of source) addAmount(target, assetId, quantity * sign)
}

/** Deterministic order: coin first, then assetId lexicographic. */
export const toAmounts = (value: ValueMap): readonly ReviewedAmount[] => {
  const entries = [...value.entries()].sort(([a], [b]) =>
    a === b ? 0 : a === COIN ? -1 : b === COIN ? 1 : a < b ? -1 : 1,
  )
  return entries.map(([assetId, quantity]) => (assetId === COIN ? {quantity} : {assetId, quantity}))
}

export const fromTokens = (
  coin: bigint,
  tokens: readonly {readonly policyIdHex: string; readonly assetNameHex: string; readonly amount: bigint}[],
): ValueMap => {
  const value: ValueMap = new Map()
  if (coin !== 0n) value.set(COIN, coin)
  for (const t of tokens) addAmount(value, `${t.policyIdHex}.${t.assetNameHex}`, t.amount)
  return value
}
