/**
 * What a Midnight transaction does to **this** wallet, from the transaction's own facts.
 *
 * The second half of `./midnight-facts.ts`: those facts are chain-shaped and say nothing about whose
 * money is whose. This adds the only two things the wallet knows and the bytes do not — its own
 * addresses, and which shielded outputs it can decrypt.
 *
 * ## ⚠️ `understood` is the point of this module, not a footnote
 *
 * Cardano's review carries the same flag and for the same reason: when some of a transaction cannot be
 * read, the figures are computed from a partial view and are **wrong, not merely rough**. A screen must
 * say the effect cannot be determined rather than render a confident number.
 *
 * Three things make an effect partial here, and they are different facts:
 *
 * - the transaction shape was not readable at all (`facts.understood === false`);
 * - a shielded offer rode along and **not every output could be decrypted** — the rest belong to
 *   someone else and their amounts are encrypted, so no key on this device can total them;
 * - an unshielded entry's own fields were unreadable, so it counts as present with a zero value.
 *
 * ⚠️ **Undecryptable shielded outputs are not "not ours".** They are "we cannot tell". A wallet that
 * treated them as somebody else's would report a receipt it could not see as a payment to a stranger.
 *
 * @module
 */

import type {MidnightTxFacts, MidnightUtxoFact} from './midnight-facts.js'

/** One shielded output this wallet decrypted. Only its own outputs can appear here. */
export type DecryptedShieldedOutput = {
  /** The token type, hex, lowercased. */
  readonly colour: string
  readonly value: bigint
}

export type MidnightEffectInput = {
  readonly facts: MidnightTxFacts
  /**
   * Every unshielded address this wallet controls, lowercased.
   *
   * ⚠️ Empty means "we do not know our own addresses", not "none of this is ours". With an empty set
   * every output reads as a payment to a stranger, so the effect is reported as not understood.
   */
  readonly ourAddresses: readonly string[]
  /**
   * The shielded outputs this wallet could decrypt, and how many it could not.
   *
   * Both halves are needed: the decrypted ones are receipts, and the count of the rest is what makes
   * the total honest about being partial.
   */
  readonly shielded?:
    | {readonly decrypted: readonly DecryptedShieldedOutput[]; readonly undecryptable: number}
    | undefined
}

/** Why an effect could only be computed from part of the transaction. */
export type MidnightEffectGap =
  /** The transaction's shape could not be read. */
  | {readonly kind: 'unreadable-transaction'}
  /** Shielded outputs whose amounts are encrypted to someone else. */
  | {readonly kind: 'shielded-not-ours'; readonly count: number}
  /** An unshielded entry whose colour or value could not be read. */
  | {readonly kind: 'unreadable-entry'; readonly count: number}
  /** This wallet does not know its own addresses, so nothing can be attributed. */
  | {readonly kind: 'own-addresses-unknown'}

export type MidnightTxEffect = {
  /**
   * Per token, what this wallet's holdings change by — negative out, positive in.
   *
   * Unshielded only, plus shielded outputs it decrypted. A token whose net is zero is omitted: a
   * self-send moves value without changing the balance and should not be listed as a movement.
   */
  readonly delta: ReadonlyMap<string, bigint>
  /** Unshielded outputs going somewhere this wallet does not control. */
  readonly toOthers: readonly MidnightUtxoFact[]
  /** Contract calls, by address and entry point, across every segment. */
  readonly calls: readonly {readonly address: string; readonly entryPoint: string}[]
  readonly deploys: readonly {readonly address: string}[]
  /** How many segments the transaction touches. More than one means several parties or several jobs. */
  readonly segments: number
  /**
   * False when any {@link MidnightEffectGap} applies.
   *
   * ⚠️ Read this before `delta`. A partial view produces figures that are wrong rather than rough.
   */
  readonly understood: boolean
  readonly gaps: readonly MidnightEffectGap[]
}

const bump = (into: Map<string, bigint>, colour: string, by: bigint): void => {
  const next = (into.get(colour) ?? 0n) + by
  if (next === 0n) into.delete(colour)
  else into.set(colour, next)
}

/**
 * Work out what a transaction does to this wallet.
 *
 * Pure, and never throws: every gap is reported rather than raised, because a review that cannot
 * compute an effect still has to render something truthful.
 */
export const midnightTxEffect = (input: MidnightEffectInput): MidnightTxEffect => {
  const {facts, ourAddresses} = input
  const ours = new Set(ourAddresses.map((one) => one.toLowerCase()))
  const gaps: MidnightEffectGap[] = []
  if (!facts.understood) gaps.push({kind: 'unreadable-transaction'})
  if (ours.size === 0) gaps.push({kind: 'own-addresses-unknown'})

  const delta = new Map<string, bigint>()
  const toOthers: MidnightUtxoFact[] = []
  let unreadableEntries = 0

  for (const intent of facts.intents) {
    for (const section of [intent.guaranteed, intent.fallible]) {
      for (const utxo of section.inputs) {
        if (utxo.colour === '') unreadableEntries += 1
        // Only our own inputs leave our holdings. Another wallet's input in the same intent is a
        // co-funded contribution, not a spend of ours — see docs/MIDNIGHT_COFUNDING_PLAN.md.
        if (ours.has(utxo.owner)) bump(delta, utxo.colour, -utxo.value)
      }
      for (const utxo of section.outputs) {
        if (utxo.colour === '') unreadableEntries += 1
        if (ours.has(utxo.owner)) bump(delta, utxo.colour, utxo.value)
        else toOthers.push(utxo)
      }
    }
  }

  for (const output of input.shielded?.decrypted ?? []) {
    // A decrypted shielded output is ours by definition — decrypting it is what proves that.
    bump(delta, output.colour, output.value)
  }
  const undecryptable = input.shielded?.undecryptable ?? 0
  if (undecryptable > 0) gaps.push({kind: 'shielded-not-ours', count: undecryptable})
  // A shielded offer with nothing decrypted and nothing counted is still unaccounted for.
  if (facts.hasShielded && input.shielded === undefined) {
    gaps.push({kind: 'shielded-not-ours', count: facts.shieldedOutputs})
  }
  if (unreadableEntries > 0) gaps.push({kind: 'unreadable-entry', count: unreadableEntries})

  return {
    delta,
    toOthers,
    calls: facts.intents.flatMap((intent) => intent.calls),
    deploys: facts.intents.flatMap((intent) => intent.deploys),
    segments: facts.intents.length,
    understood: gaps.length === 0,
    gaps,
  }
}

/** How a gap reads to a person or an agent. Says what is missing, never implies a figure. */
export const describeMidnightGap = (gap: MidnightEffectGap): string => {
  switch (gap.kind) {
    case 'unreadable-transaction':
      return 'this transaction is not a shape this wallet can read'
    case 'shielded-not-ours':
      return `${gap.count} shielded output(s) are encrypted to someone else, so their amounts cannot be counted`
    case 'unreadable-entry':
      return `${gap.count} entr(y/ies) could not be read, so the totals leave them out`
    case 'own-addresses-unknown':
      return 'this wallet does not know its own addresses, so nothing can be attributed to it'
  }
}
