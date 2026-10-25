/**
 * The same facts, parsed from the **native** reader's JSON.
 *
 * `./midnight-facts.ts` reads a *deserialized* transaction, which needs the ledger — and the ledger
 * reaches a phone only through `@pnyx/midnight-native` (Hermes has no WASM). So the device reads its
 * facts in Rust (`rust/src/facts.rs`) and this parses that answer into the one type both hosts share.
 *
 * ⚠️ **Parsed, not trusted.** A field of the wrong type is a bridge that has drifted, and the failure
 * mode of trusting it is the worst one available here: `Number` over a `u128` would round a large
 * token's amount, and a review would name a figure that is not what gets signed. Every value is
 * checked, and a value that cannot be read is reported through `understood: false` rather than
 * defaulted — see {@link parseMidnightTxFactsJson}.
 *
 * ⚠️ **Amounts cross as decimal strings** for that reason, exactly as `txBalance`'s `delta` does.
 *
 * @module
 */

import type {MidnightIntentFact, MidnightTxFacts, MidnightUtxoFact} from './midnight-facts.js'

/** Facts nothing could be read from — what every refusal below returns. */
const UNREADABLE: MidnightTxFacts = {
  networkId: '',
  intents: [],
  shieldedOutputs: 0,
  hasShielded: false,
  understood: false,
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/** A decimal string as a bigint, or `null` when it is not one. Never `0n` by default. */
const amountOf = (value: unknown): bigint | null =>
  typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : null

const hexOf = (value: unknown): string | null =>
  typeof value === 'string' && /^[0-9a-f]*$/i.test(value) ? value.toLowerCase() : null

/**
 * One UTXO, with a flag for whether every field of it was legible.
 *
 * An entry that could not be read is **kept** with an empty colour and a zero value, matching the
 * other reader: dropping it would make the transaction look smaller than it is, and the caller counts
 * it as a gap through `MidnightEffectGap.unreadable-entry` (an empty colour is the marker).
 */
const utxoOf = (raw: unknown): MidnightUtxoFact => {
  const row = asRecord(raw)
  const colour = hexOf(row?.colour)
  const value = amountOf(row?.value)
  const owner = hexOf(row?.owner)
  if (row === null || colour === null || value === null || owner === null) {
    return {colour: '', value: 0n, owner: ''}
  }
  return {colour, value, owner}
}

const sideOf = (raw: unknown, side: 'inputs' | 'outputs'): readonly MidnightUtxoFact[] => {
  const entries = asRecord(raw)?.[side]
  return Array.isArray(entries) ? entries.map(utxoOf) : []
}

const sectionOf = (raw: unknown) => ({inputs: sideOf(raw, 'inputs'), outputs: sideOf(raw, 'outputs')})

const wholeNumberOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null

const intentOf = (raw: unknown): MidnightIntentFact | null => {
  const row = asRecord(raw)
  const segment = wholeNumberOf(row?.segment)
  const declaredOther = wholeNumberOf(row?.otherActions)
  // A malformed count is not defaulted to zero: it would report an intent as carrying fewer actions
  // than it does. The whole intent is reported unreadable instead, which narrows `understood`.
  if (row === null || segment === null || declaredOther === null) return null
  if (!Array.isArray(row.calls) || !Array.isArray(row.deploys)) return null

  const calls: {readonly address: string; readonly entryPoint: string}[] = []
  const deploys: {readonly address: string}[] = []
  /**
   * An action whose own fields would not read.
   *
   * ⚠️ Counted into `otherActions`, never dropped: a call whose address or entry point is illegible
   * is still a call, and a transaction that looked like it made none would be the wrong thing to put
   * in front of someone about to approve it.
   */
  let unnameable = 0
  for (const entry of row.calls) {
    const call = asRecord(entry)
    const address = hexOf(call?.address)
    if (address === null || typeof call?.entryPoint !== 'string') {
      unnameable += 1
      continue
    }
    calls.push({address, entryPoint: call.entryPoint})
  }
  for (const entry of row.deploys) {
    const address = hexOf(asRecord(entry)?.address)
    if (address === null) {
      unnameable += 1
      continue
    }
    deploys.push({address})
  }

  return {
    segment,
    ttlSecs: wholeNumberOf(row.ttlSecs),
    guaranteed: sectionOf(row.guaranteed),
    fallible: sectionOf(row.fallible),
    calls,
    deploys,
    otherActions: declaredOther + unnameable,
  }
}

/**
 * The facts, and whether the answer they came from could be read at all.
 *
 * ⚠️ **`unreadable` is not `!facts.understood`, and conflating them loses a diagnosis.** A rewards
 * claim is a transaction the ledger read perfectly and this IR does not describe — `understood: false`,
 * `unreadable: null`. An answer that is not JSON, or is JSON of the wrong shape, is a **bridge that has
 * drifted**: the same `understood: false` on screen, and an entirely different thing to fix. It travels
 * in the return value rather than being logged here because this package is pure and holds no logger;
 * every caller logs it (CLAUDE.md's "every caught error logs" — captured, reported, and never dropped).
 */
export type MidnightTxFactsRead = {
  readonly facts: MidnightTxFacts
  /** Why the answer could not be read, or `null` when it was. */
  readonly unreadable: string | null
}

/**
 * Read the native `txFacts` answer.
 *
 * Never throws: a review that crashes on a transaction tells the person less than one that says it
 * could not read it. Anything unparseable comes back with `understood: false` **and** a stated reason.
 *
 * ⚠️ **`understood` is the native reader's own verdict, and it is only ever narrowed here.** A shape
 * the ledger could read but this parser could not is still not understood — so a `true` that arrives
 * beside an unreadable intent list does not survive.
 */
export const readMidnightTxFactsJson = (json: string): MidnightTxFactsRead => {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    return {facts: UNREADABLE, unreadable: `the reader's answer is not JSON: ${String(error)}`}
  }
  const row = asRecord(parsed)
  if (row === null) {
    return {facts: UNREADABLE, unreadable: 'the reader answered something that is not an object'}
  }

  const networkId = typeof row.networkId === 'string' ? row.networkId : ''
  const shieldedOutputs = wholeNumberOf(row.shieldedOutputs)
  const hasShielded = typeof row.hasShielded === 'boolean' ? row.hasShielded : null
  if (!Array.isArray(row.intents) || shieldedOutputs === null || hasShielded === null) {
    return {
      facts: {...UNREADABLE, networkId},
      unreadable: 'the reader’s answer is missing `intents`, `shieldedOutputs` or `hasShielded`',
    }
  }

  const intents = row.intents.map(intentOf)
  const readable = intents.filter((one): one is MidnightIntentFact => one !== null)
  return {
    facts: {
      networkId,
      // Ascending, for the same reason the other reader sorts: a segment id says which contributor's
      // intent an entry belongs to, and which segment a deficit could be funded from.
      intents: [...readable].sort((a, b) => a.segment - b.segment),
      shieldedOutputs,
      hasShielded,
      understood: row.understood === true && readable.length === intents.length,
    },
    // An intent this parser could not read is a drift too, and it is named rather than left to
    // `understood` alone — which cannot say *which* half went wrong.
    unreadable:
      readable.length === intents.length
        ? null
        : `${intents.length - readable.length} of ${intents.length} intents could not be read`,
  }
}
