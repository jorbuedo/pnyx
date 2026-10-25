/**
 * Fold `unshieldedTransactions` events into the UTxO set an address currently holds.
 *
 * Pure, and separate from the socket that feeds it, because the interesting part is the bookkeeping:
 * the subscription replays every transaction that ever touched the address, so a UTxO that was created
 * in one event and spent in a later one must not survive the fold. What the screens want is the
 * *unspent* remainder.
 *
 * @module
 */

/**
 * NIGHT — the unshielded native token, whose type is 32 zero bytes.
 *
 * Pinned here rather than read from `nativeToken()` in `@midnight-ntwrk/ledger-v8`, because that entry
 * point is WASM and Hermes has none; `unshielded-native-token.test.ts` asserts the two agree, so the
 * constant cannot drift from the ledger without a test failing.
 *
 * ⚠️ Every other token type on the unshielded ledger is *not* NIGHT, including bridged USDM. A balance
 * that summed token types together would add unrelated assets, so callers look this one up by key.
 */
export const NIGHT_TOKEN_TYPE = '0000000000000000000000000000000000000000000000000000000000000000'

/** An unshielded UTxO as the indexer reports it. `value` stays a string here — see {@link parseValue}. */
import {logger} from '../../../logger'

export type IndexedUnshieldedUtxo = {
  readonly owner: string
  readonly tokenType: string
  readonly value: string
  readonly intentHash: string
  readonly outputIndex: number
  readonly ctime?: number | null
  readonly registeredForDustGeneration?: boolean
  readonly createdAtTransaction?: {readonly hash?: string} | null
}

export type UnshieldedUtxo = {
  readonly owner: string
  readonly tokenType: string
  /** Atomic units. `bigint` because NIGHT has 6 decimals and a balance must not round. */
  readonly value: bigint
  readonly intentHash: string
  readonly outputIndex: number
  readonly ctime: number | null
  readonly registeredForDustGeneration: boolean
  /**
   * The transaction that created this output, when the indexer said. Distinct from `intentHash`, which
   * identifies the output — one transaction carries several intents, so the intent hash cannot be used to
   * look the transaction up.
   */
  readonly createdAtTxHash?: string
}

export type UnshieldedEvent = {
  readonly createdUtxos?: readonly IndexedUnshieldedUtxo[] | null
  readonly spentUtxos?: readonly IndexedUnshieldedUtxo[] | null
}

/**
 * A UTxO's identity on chain: the intent that created it plus its position in that intent's outputs.
 * Not the transaction hash — one transaction can carry several intents.
 */
export const utxoKey = (utxo: {readonly intentHash: string; readonly outputIndex: number}): string =>
  `${utxo.intentHash.toLowerCase()}:${utxo.outputIndex}`

/**
 * Parse the indexer's decimal string. Returns `null` for anything that is not a non-negative integer,
 * so a malformed value is dropped from the set rather than counted as `0` — a balance that silently
 * omits a coin is wrong, but a balance that counts an unreadable coin as nothing is wrong *and* looks
 * authoritative.
 */
export const parseValue = (raw: string): bigint | null => {
  if (!/^\d+$/.test(raw)) return null
  try {
    return BigInt(raw)
  } catch (e: unknown) {
    // Unreachable for a digit-only string, but BigInt is the only thing here that can throw and a
    // silent null would hide a platform difference rather than report it — which is what this
    // handler did until the line below existed.
    logger.warn('A digit-only string would not convert to a bigint; this is a platform difference', {
      origin: 'midnight/unshielded-utxo-set',
      raw,
      error: String(e),
    })
    return null
  }
}

const normalize = (utxo: IndexedUnshieldedUtxo): UnshieldedUtxo | null => {
  const value = parseValue(utxo.value)
  if (value === null) return null
  return {
    owner: utxo.owner,
    tokenType: utxo.tokenType.toLowerCase(),
    value,
    intentHash: utxo.intentHash.toLowerCase(),
    outputIndex: utxo.outputIndex,
    ctime: utxo.ctime ?? null,
    registeredForDustGeneration: utxo.registeredForDustGeneration ?? false,
    ...(utxo.createdAtTransaction?.hash === undefined ? {} : {createdAtTxHash: utxo.createdAtTransaction.hash}),
  }
}

/**
 * Apply one event to `set`, returning a new map keyed by {@link utxoKey}.
 *
 * ⚠️ **Filtered on `owner`, not trusted from the subscription.** The schema documents `createdUtxos` as
 * "UTXOs created in the above transaction", which does not promise they are all ours — and a transaction
 * that pays us also pays its own change. Filtering here is correct whether or not the indexer already
 * did it; not filtering is only correct if it did.
 *
 * Spends are applied after creations, so a UTxO created and spent inside one transaction does not linger.
 */
export const applyUnshieldedEvent = (
  set: ReadonlyMap<string, UnshieldedUtxo>,
  event: UnshieldedEvent,
  address: string,
): ReadonlyMap<string, UnshieldedUtxo> => {
  const next = new Map(set)
  for (const raw of event.createdUtxos ?? []) {
    if (raw.owner !== address) continue
    const utxo = normalize(raw)
    if (utxo !== null) next.set(utxoKey(utxo), utxo)
  }
  for (const raw of event.spentUtxos ?? []) {
    if (raw.owner !== address) continue
    next.delete(utxoKey(raw))
  }
  return next
}

/** Total per token type. An empty set totals to an empty map, never to a zero for some assumed token. */
export const totalsByToken = (set: ReadonlyMap<string, UnshieldedUtxo>): ReadonlyMap<string, bigint> => {
  const totals = new Map<string, bigint>()
  for (const utxo of set.values()) {
    totals.set(utxo.tokenType, (totals.get(utxo.tokenType) ?? 0n) + utxo.value)
  }
  return totals
}
