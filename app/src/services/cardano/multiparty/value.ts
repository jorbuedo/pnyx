/**
 * Value arithmetic for multiparty composition: lovelace plus native tokens, added,
 * subtracted and compared.
 *
 * Its own module because every rule in `compose.ts` is a subtraction over these — what a
 * party puts in, what comes back — and a sign error in any of them moves somebody else's
 * money. Pure, tiny, and exhaustively tested, so the composer can be read as arithmetic
 * rather than as bookkeeping.
 *
 * Assets are keyed `policyHex.nameHex`, the shape `UTxO.UTxO.value.assets` uses. A zero
 * quantity is **dropped rather than kept**: `{A: 0}` and `{}` are the same value, and
 * keeping the key would make an output carry an asset entry for nothing, inflate its
 * min-ADA, and make two equal values compare unequal.
 *
 * @module
 */

export type AssetMap = ReadonlyMap<string, bigint>

export type Value = {
  readonly lovelace: bigint
  readonly assets: AssetMap
}

export const emptyValue: Value = {lovelace: 0n, assets: new Map()}

export const makeValue = (lovelace: bigint, assets?: AssetMap): Value => ({
  lovelace,
  assets: normaliseAssets(assets ?? new Map()),
})

/** Drop zero entries — see the module note on why `{A: 0}` must equal `{}`. */
const normaliseAssets = (assets: AssetMap): AssetMap => {
  const out = new Map<string, bigint>()
  for (const [id, quantity] of assets) if (quantity !== 0n) out.set(id, quantity)
  return out
}

export const addValues = (a: Value, b: Value): Value => {
  const assets = new Map(a.assets)
  for (const [id, quantity] of b.assets) assets.set(id, (assets.get(id) ?? 0n) + quantity)
  return {lovelace: a.lovelace + b.lovelace, assets: normaliseAssets(assets)}
}

/**
 * `a − b`, which may go negative in any component.
 *
 * Negatives are *representable on purpose*: the caller decides whether a shortfall is an
 * error, and hiding it by clamping at zero would turn "you are 5 ADA short" into a
 * balanced transaction that spends money nobody has.
 */
export const subtractValues = (a: Value, b: Value): Value => {
  const assets = new Map(a.assets)
  for (const [id, quantity] of b.assets) assets.set(id, (assets.get(id) ?? 0n) - quantity)
  return {lovelace: a.lovelace - b.lovelace, assets: normaliseAssets(assets)}
}

/** True when `a` holds at least `b` of everything — the test for "can this be paid". */
export const valueCovers = (a: Value, b: Value): boolean => {
  if (a.lovelace < b.lovelace) return false
  for (const [id, quantity] of b.assets) if ((a.assets.get(id) ?? 0n) < quantity) return false
  return true
}

export const isEmptyValue = (v: Value): boolean => v.lovelace === 0n && v.assets.size === 0

export const isPositiveValue = (v: Value): boolean => v.lovelace > 0n || v.assets.size > 0

/** Any negative component — a shortfall the caller has to report rather than absorb. */
export const hasNegative = (v: Value): boolean => {
  if (v.lovelace < 0n) return true
  for (const [, quantity] of v.assets) if (quantity < 0n) return true
  return false
}

export const sumValues = (values: readonly Value[]): Value => values.reduce(addValues, emptyValue)
