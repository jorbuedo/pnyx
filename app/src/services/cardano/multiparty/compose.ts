/**
 * Composing a multiparty transaction: who puts in what, which of their coins pay for it,
 * and what comes back to them.
 *
 * A multiparty transaction spends UTxOs belonging to several *ordinary* wallets — one
 * required signature per contributing wallet, no native script, no quorum rule. The
 * composer can select another party's inputs because they watch that wallet read-only;
 * building a body needs no key, only knowledge of the UTxOs.
 *
 * **The whole reason this module exists, and is pure:**
 *
 * `CardanoPlan` has exactly **one** `changeAddressHex`. It belongs to the composer,
 * because the planner needs a single address to absorb the fee remainder. So every
 * lovelace of a *co-contributor's* input that is not explicitly sent somewhere becomes the
 * composer's change. Spend Bob's 200 ADA input to send 25 and the other 175 lands in
 * Alice's wallet — silently, because that is precisely what coin selection is for.
 *
 * Therefore:
 *
 * > **A co-contributor's return is an explicit output, never change.**
 *
 * and the composer's change is correct *only* because every other return is exact. The two
 * facts are the same fact. Keeping the arithmetic here — no codec, no rail, no network —
 * is what lets that be a unit test instead of a preprod transaction nobody wants to send
 * twice.
 *
 * **Every party selects its own coins.** An earlier version pinned *all* of a party's
 * UTxOs as mandatory, which meant a contributor with 200 fragmented UTxOs spent all 200 to
 * put in 3 ADA — and was the real source of the transaction-size pressure that looked like
 * it needed transaction splitting to solve. Each party now selects only what covers its
 * own contribution, and *those* are pinned. Pinned rather than left selectable because
 * coin selection dropping a party's inputs drops the party from the roster: the body is
 * what `extractRequiredSigners` reads, so a party whose coins were optimised away stops
 * being asked to sign — including, as observed, the composer.
 *
 * **Returns go to the source address.** With the shipped read-only importer
 * (`app/onboarding/watch-only.tsx`: a stake credential resolved to an address list) there
 * is no xpub, so no fresh address can be derived for a co-contributor — return-to-source
 * is not merely the safest option, it is the only one. It also preserves their staking,
 * and on review they see their funds go back exactly where they left. The cost is address
 * reuse.
 *
 * **Contributions are values, not lovelace.** A party can put in tokens as well as ADA,
 * and whatever they do not put in comes back — tokens included. Denominating in lovelace
 * alone would have swept a contributor's tokens into the composer's change, which is the
 * same theft in a different denomination.
 *
 * N parties, not two: every rule below is per contributor and the failures name which one.
 *
 * @module
 */

import {
  type AssetMap,
  addValues,
  emptyValue,
  hasNegative,
  isEmptyValue,
  isPositiveValue,
  makeValue,
  subtractValues,
  sumValues,
  type Value,
  valueCovers,
} from './value'

export type {AssetMap, Value}

/** One UTxO a party could put in. `txHash` is hex — `UTxO.UTxO` carries bytes; convert at the edge. */
export type ContributedUtxo = {
  readonly txHash: string
  readonly index: number
  /** Where it came from, and therefore where this party's return goes. */
  readonly addressHex: string
  readonly lovelace: bigint
  readonly assets?: AssetMap
}

export type Contribution = {
  readonly walletId: string
  readonly name: string
  /** Everything this party *could* spend. Only what the contribution needs is selected. */
  readonly available: readonly ContributedUtxo[]
  /** What this party puts toward the recipients. Their surplus returns to them. */
  readonly value: Value
  /** The party building the transaction: owns the change, and so pays the fee. */
  readonly isComposer?: boolean
}

/** What one party actually spends, and what comes back to them. */
export type PartyPlan = {
  readonly walletId: string
  readonly name: string
  readonly isComposer: boolean
  /** The coins this party puts in — pinned, so the planner may not drop them. */
  readonly selected: readonly ContributedUtxo[]
  /** Their surplus. Empty when they contributed exactly what they selected. */
  readonly returned: Value
  /** Where the return goes: the source address of their largest selected input. */
  readonly returnAddressHex: string
}

export type ComposedMultiparty = {
  readonly composerWalletId: string
  /** The composer's change address — where the fee remainder lands. */
  readonly changeAddressHex: string
  readonly parties: readonly PartyPlan[]
  /**
   * Every party's selected coins. All mandatory: a contribution is a commitment and the
   * planner may not re-decide it for anyone.
   */
  readonly mandatoryInputs: readonly ContributedUtxo[]
  /** One per co-contributor with something to get back. Explicit outputs, never change. */
  readonly returns: readonly PartyPlan[]
  /** What the recipients receive in total — the sum of every contribution. */
  readonly total: Value
}

export type ComposeFailure =
  /** A multiparty transaction with one party is an ordinary send; use that funnel. */
  | {readonly kind: 'single-contributor'}
  | {readonly kind: 'no-composer'}
  | {readonly kind: 'multiple-composers'}
  /** The composer owns the change and therefore pays the fee out of it. */
  | {readonly kind: 'composer-has-no-inputs'}
  | {readonly kind: 'party-has-no-inputs'; readonly walletId: string; readonly name: string}
  /** Contributing nothing while still owing a signature: pointless, and confusing on review. */
  | {readonly kind: 'zero-contribution'; readonly walletId: string; readonly name: string}
  | {
      readonly kind: 'contribution-exceeds-inputs'
      readonly walletId: string
      readonly name: string
      readonly available: Value
      readonly requested: Value
    }
  /**
   * Everything this party holds is either contributed or needed to keep the return above
   * min-ADA, and it does not reach. Never folded into the fee — that would silently make
   * them pay it.
   */
  | {
      readonly kind: 'return-below-min-ada'
      readonly walletId: string
      readonly name: string
      readonly returned: bigint
      readonly minimum: bigint
    }
  /** The same UTxO offered by two parties — one of the two read-only sets is wrong. */
  | {readonly kind: 'duplicate-input'; readonly txHash: string; readonly index: number}

export type ComposeResult =
  | {readonly ok: true; readonly composed: ComposedMultiparty}
  | {readonly ok: false; readonly failure: ComposeFailure}

/** The minimum lovelace an output holding this value at this address may carry. */
export type MinAdaFor = (input: {readonly addressHex: string; readonly value: Value}) => bigint

const utxoValue = (utxo: ContributedUtxo): Value => makeValue(utxo.lovelace, utxo.assets)

const utxoId = (utxo: ContributedUtxo): string => `${utxo.txHash}#${utxo.index}`

/**
 * Order a party's coins for selection: the ones carrying a contributed asset first, then
 * largest ADA.
 *
 * Asset-first because a token can only come from a UTxO that holds it, and largest-ADA
 * after because fewer, bigger inputs make a smaller transaction — which is the bound this
 * whole per-party selection exists to stay under.
 */
const orderForSelection = (utxos: readonly ContributedUtxo[], wanted: Value): readonly ContributedUtxo[] => {
  const carriesWanted = (utxo: ContributedUtxo): boolean => {
    for (const id of wanted.assets.keys()) if ((utxo.assets?.get(id) ?? 0n) > 0n) return true
    return false
  }
  return [...utxos].sort((a, b) => {
    const byAsset = Number(carriesWanted(b)) - Number(carriesWanted(a))
    return byAsset !== 0 ? byAsset : a.lovelace < b.lovelace ? 1 : a.lovelace > b.lovelace ? -1 : 0
  })
}

/**
 * Pick the coins one party spends.
 *
 * Two conditions, and the second is the subtle one: the selection must cover the
 * contribution **and** leave a return that can exist as an output. A surplus of 100
 * lovelace is not a return — it is below any min-ADA — so more coins are drawn until the
 * surplus clears the bar or the party runs out. Landing exactly on zero with no tokens is
 * the one acceptable remainder: nothing comes back and no output is written.
 */
const selectFor = (
  party: Contribution,
  minAdaFor: MinAdaFor,
): {readonly selected: readonly ContributedUtxo[]; readonly returned: Value} | ComposeFailure => {
  const ordered = orderForSelection(party.available, party.value)
  const selected: ContributedUtxo[] = []
  let pooled = emptyValue

  for (const utxo of ordered) {
    if (valueCovers(pooled, party.value)) {
      const surplus = subtractValues(pooled, party.value)
      if (isEmptyValue(surplus)) break
      const needed = minAdaFor({addressHex: returnAddressOf(selected), value: surplus})
      if (surplus.lovelace >= needed) break
    }
    selected.push(utxo)
    pooled = addValues(pooled, utxoValue(utxo))
  }

  if (!valueCovers(pooled, party.value)) {
    return {
      kind: 'contribution-exceeds-inputs',
      walletId: party.walletId,
      name: party.name,
      available: pooled,
      requested: party.value,
    }
  }

  const returned = subtractValues(pooled, party.value)
  if (isEmptyValue(returned)) return {selected, returned}
  const minimum = minAdaFor({addressHex: returnAddressOf(selected), value: returned})
  if (returned.lovelace < minimum) {
    return {
      kind: 'return-below-min-ada',
      walletId: party.walletId,
      name: party.name,
      returned: returned.lovelace,
      minimum,
    }
  }
  return {selected, returned}
}

/**
 * Where a party's return goes: the address of their largest selected input.
 *
 * Largest rather than first because input order is whatever the UTxO query produced, and a
 * return should land on the address the party most obviously recognises as theirs.
 */
const returnAddressOf = (utxos: readonly ContributedUtxo[]): string =>
  utxos.length === 0
    ? ''
    : utxos.reduce((largest, utxo) => (utxo.lovelace > largest.lovelace ? utxo : largest)).addressHex

const isFailure = (value: unknown): value is ComposeFailure =>
  typeof value === 'object' && value !== null && 'kind' in value

export const composeMultiparty = (contributions: readonly Contribution[], minAdaFor: MinAdaFor): ComposeResult => {
  if (contributions.length < 2) return {ok: false, failure: {kind: 'single-contributor'}}

  const composers = contributions.filter((c) => c.isComposer === true)
  if (composers.length === 0) return {ok: false, failure: {kind: 'no-composer'}}
  if (composers.length > 1) return {ok: false, failure: {kind: 'multiple-composers'}}
  const composer = composers[0] as Contribution

  // A UTxO claimed by two parties means one party's watched address set is wrong, and the
  // body would double-spend it. Caught here rather than at submit.
  const seen = new Set<string>()
  for (const contribution of contributions) {
    for (const utxo of contribution.available) {
      if (seen.has(utxoId(utxo))) {
        return {ok: false, failure: {kind: 'duplicate-input', txHash: utxo.txHash, index: utxo.index}}
      }
      seen.add(utxoId(utxo))
    }
  }

  for (const contribution of contributions) {
    if (contribution.available.length === 0) {
      return contribution.walletId === composer.walletId
        ? {ok: false, failure: {kind: 'composer-has-no-inputs'}}
        : {ok: false, failure: {kind: 'party-has-no-inputs', walletId: contribution.walletId, name: contribution.name}}
    }
    if (!isPositiveValue(contribution.value) || hasNegative(contribution.value)) {
      return {ok: false, failure: {kind: 'zero-contribution', walletId: contribution.walletId, name: contribution.name}}
    }
  }

  const parties: PartyPlan[] = []
  for (const contribution of contributions) {
    const picked = selectFor(contribution, minAdaFor)
    if (isFailure(picked)) return {ok: false, failure: picked}
    parties.push({
      walletId: contribution.walletId,
      name: contribution.name,
      isComposer: contribution.walletId === composer.walletId,
      selected: picked.selected,
      returned: picked.returned,
      returnAddressHex: returnAddressOf(picked.selected),
    })
  }

  const composerPlan = parties.find((p) => p.isComposer) as PartyPlan
  return {
    ok: true,
    composed: {
      composerWalletId: composer.walletId,
      changeAddressHex: composerPlan.returnAddressHex,
      parties,
      mandatoryInputs: parties.flatMap((p) => [...p.selected]),
      // The composer's surplus is the plan's change, which is what absorbs the fee — so it
      // is *not* written as an explicit output. Every other party's is.
      returns: parties.filter((p) => !p.isComposer && !isEmptyValue(p.returned)),
      total: sumValues(contributions.map((c) => c.value)),
    },
  }
}
