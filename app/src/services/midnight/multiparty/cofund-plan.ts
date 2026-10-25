/**
 * Turning "these wallets, this much each, to that address" into the contributions the native
 * co-funding builder takes — as a pure decision.
 *
 * Its own module for the same reason as the Cardano half's `compose.ts`: the orchestration opens a
 * rail and reaches the native bridge, and *this* is the part where getting it wrong is a silently
 * wrong transaction rather than a crash.
 *
 * ⚠️ **This is shape C** — several wallets funding **one** payment
 * (`docs/MIDNIGHT_COFUNDING_PLAN.md`). Not `Transaction::merge`, which bundles independent payments
 * and pools nothing.
 *
 * @module
 */

import type {UnshieldedUtxo} from '../wallet/unshielded-utxo-set'

/** One wallet's offer to a co-funded payment, before its inputs are chosen. */
export type CoFundSource = {
  /** The granted scope this wallet is, as the agent and the review name it. */
  readonly scopeKey: string
  /** For a person: which wallet this is. */
  readonly name: string
  /** The wallet's Night verifying key — 32 bytes, the `UtxoSpend.owner` of its inputs. */
  readonly owner: Uint8Array
  /** What it has to spend, already scoped to the token being sent. */
  readonly utxos: readonly UnshieldedUtxo[]
  /** What it is putting in. */
  readonly pledge: bigint
}

/** A source with its inputs chosen — what the native builder packs. */
export type PlannedContribution = {
  readonly scopeKey: string
  readonly name: string
  readonly owner: Uint8Array
  readonly inputs: readonly UnshieldedUtxo[]
  readonly pledge: bigint
}

export type CoFundPlanFailure =
  /** No sources, or every source pledged nothing — there is no payment to make. */
  | {readonly kind: 'nothing-pledged'}
  /** One wallet cannot cover what it offered. Names it, because that is the actionable half. */
  | {readonly kind: 'source-short'; readonly name: string; readonly pledge: bigint; readonly held: bigint}
  /** Two sources are the same wallet. Their inputs would be gathered twice. */
  | {readonly kind: 'duplicate-source'; readonly name: string}

export type CoFundPlan =
  | {readonly ok: true; readonly contributions: readonly PlannedContribution[]; readonly payment: bigint}
  | {readonly ok: false; readonly failure: CoFundPlanFailure}

/**
 * Largest-first, exactly as the single-party selector does, and for the same reason: any other order
 * needs at least as many inputs for the same amount, and every input is a signature and a byte cost.
 */
const cover = (utxos: readonly UnshieldedUtxo[], amount: bigint): readonly UnshieldedUtxo[] | null => {
  const largestFirst = [...utxos].sort((a, b) => (a.value === b.value ? 0 : a.value > b.value ? -1 : 1))
  const chosen: UnshieldedUtxo[] = []
  let total = 0n
  for (const utxo of largestFirst) {
    chosen.push(utxo)
    total += utxo.value
    if (total >= amount) return chosen
  }
  return null
}

/**
 * Choose each wallet's inputs for its pledge.
 *
 * ⚠️ **Every chosen input is spent whole and its remainder returns to its own owner** — the native
 * builder writes that change output, not this. So a wallet that pledges 1 and holds a single 1,000
 * input contributes 1 and gets 999 back; it does not need exact change and must not be refused for
 * lacking it.
 *
 * ⚠️ **The payment is the sum of the pledges, not a figure the caller passes separately.** A caller
 * that could state both would eventually state two different things, and the transaction would be
 * built from one of them.
 */
export const planCoFunding = (sources: readonly CoFundSource[]): CoFundPlan => {
  const seen = new Set<string>()
  for (const source of sources) {
    if (seen.has(source.scopeKey)) return {ok: false, failure: {kind: 'duplicate-source', name: source.name}}
    seen.add(source.scopeKey)
  }

  const pledging = sources.filter((source) => source.pledge > 0n)
  if (pledging.length === 0) return {ok: false, failure: {kind: 'nothing-pledged'}}

  const contributions: PlannedContribution[] = []
  let payment = 0n
  for (const source of pledging) {
    const inputs = cover(source.utxos, source.pledge)
    if (inputs === null) {
      const held = source.utxos.reduce((sum, utxo) => sum + utxo.value, 0n)
      return {ok: false, failure: {kind: 'source-short', name: source.name, pledge: source.pledge, held}}
    }
    contributions.push({
      scopeKey: source.scopeKey,
      name: source.name,
      owner: source.owner,
      inputs,
      pledge: source.pledge,
    })
    payment += source.pledge
  }
  return {ok: true, contributions, payment}
}

/** How a refusal reads to an agent or a person — the wallet is named, because that is what to act on. */
export const describeCoFundFailure = (failure: CoFundPlanFailure): string => {
  switch (failure.kind) {
    case 'nothing-pledged':
      return 'no wallet put anything into this payment'
    case 'source-short':
      return `${failure.name} pledged ${failure.pledge} but holds ${failure.held}`
    case 'duplicate-source':
      return `${failure.name} was given twice; each wallet contributes once`
  }
}
