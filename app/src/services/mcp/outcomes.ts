/**
 * What became of the transactions an agent handed off.
 *
 * ⚠️ **The hole this fills.** A builder answers the moment the review opens — `awaitingApproval: true`
 * plus the hash the body will land under — because holding the socket through a person's decision is
 * what once made an agent report a landed transaction as failed
 * (`[[agent-answered-at-handoff]]`, preprod block 5,105,159). Answering early is right, but it left the
 * agent with no way to learn what happened *next*: approved or declined, submitted or not. It had to
 * guess, and a model that guesses about money guesses confidently.
 *
 * So the wallet remembers, and the agent asks.
 *
 * ⚠️ **Only facts this wallet generated.** A stage, a hash, a count, a timestamp — never text that came
 * from anywhere else. This is an input channel into an agent that holds signing scopes, and the moment
 * it can carry a string somebody else wrote (a memo, an asset name, a dApp title) it becomes a prompt
 * injection route. `docs/MCP_DEV_TOOL_SPEC.md` §6 is the standing rule; this module is why it matters.
 *
 * ⚠️ **In memory and bounded**, like the activity tail. An agent's own history of what it did is a live
 * signal, not a record to keep about its owner — and the wallet's real transaction history is already
 * readable through `cardano_listHistory`, so nothing here is information an agent could not already
 * get. That is also why it is not partitioned per agent: it exposes no more than the history does.
 *
 * @module
 */

/** Which chain a handed-off transaction belongs to. */
export type OutcomeChain = 'cardano' | 'midnight'

/**
 * How far a handed-off transaction got.
 *
 * ⚠️ `submitted` is **not** `confirmed`. The wallet broadcasts and the chain decides later; conflating
 * them is the "accepted is not landed" mistake this repo has made on two surfaces already. Whether it
 * landed is looked up by hash when an agent asks, not recorded here as though it were known.
 */
export type OutcomeStage =
  /** The review opened and the person has not decided yet. */
  | 'awaiting-approval'
  /** Approved, signed and broadcast. Landing is a separate question. */
  | 'submitted'
  /** The person declined it. */
  | 'declined'
  /** Nobody decided before the review timed out. ⚠️ Never reported as `declined`. */
  | 'unanswered'
  /** Approved, but nothing reached the chain — the wallet's own failure, not the person's. */
  | 'not-submitted'

export type AgentOutcome = {
  /** The hash the body lands under. Known before signing, which is what makes it the key. */
  readonly txHash: string
  readonly chain: OutcomeChain
  readonly stage: OutcomeStage
  /** When the stage was last set, epoch ms. */
  readonly at: number
}

/** How many hand-offs to remember. Small: this is what an agent is still waiting to hear about. */
export const OUTCOME_CAP = 50

const outcomes = new Map<string, AgentOutcome>()

/**
 * Record a stage for a transaction, replacing any earlier stage for the same hash.
 *
 * Keyed by hash rather than appended, because an agent asking "what happened to this?" wants the
 * current answer, not a history of the wallet changing its mind.
 */
export const recordOutcome = (outcome: AgentOutcome): void => {
  outcomes.delete(outcome.txHash)
  outcomes.set(outcome.txHash, outcome)
  // Oldest first in insertion order, so dropping from the front drops the least recently updated.
  while (outcomes.size > OUTCOME_CAP) {
    const oldest = outcomes.keys().next()
    if (oldest.done === true) break
    outcomes.delete(oldest.value)
  }
}

/** Every remembered outcome for one chain, most recently updated first. */
export const listOutcomes = (chain: OutcomeChain): readonly AgentOutcome[] =>
  [...outcomes.values()].filter((outcome) => outcome.chain === chain).reverse()

/** Forget everything — used when serving stops, and by tests. */
export const forgetOutcomes = (): void => {
  outcomes.clear()
}

/**
 * What to tell an agent about one transaction, given what the chain currently says.
 *
 * ⚠️ **Pure, and separate from the store, because this is the part that must not lie.** `confirmed` is
 * only ever reported from the chain's own answer; a `submitted` transaction the chain has not
 * confirmed reads as `submitted`, never as landed. `unknown` confirmation is reported as such rather
 * than as "not confirmed" — an agent that cannot tell "not yet" from "no" retries or gives up wrongly.
 */
export const describeOutcome = (
  outcome: AgentOutcome,
  confirmation: 'confirmed' | 'failed' | 'pending' | 'unknown',
): {
  readonly txHash: string
  readonly stage: OutcomeStage
  readonly landed: boolean | null
  readonly detail: string
} => {
  if (outcome.stage !== 'submitted') {
    return {
      txHash: outcome.txHash,
      stage: outcome.stage,
      landed: outcome.stage === 'awaiting-approval' ? null : false,
      detail:
        outcome.stage === 'awaiting-approval'
          ? 'the person has not decided yet'
          : outcome.stage === 'declined'
            ? 'the person declined it'
            : outcome.stage === 'unanswered'
              ? 'nobody decided before the review timed out — this is not a refusal, and asking again is reasonable'
              : 'it was approved but nothing reached the chain, which is this wallet’s failure and not the person’s',
    }
  }
  if (confirmation === 'confirmed') {
    return {txHash: outcome.txHash, stage: 'submitted', landed: true, detail: 'the chain has it'}
  }
  if (confirmation === 'failed') {
    return {txHash: outcome.txHash, stage: 'submitted', landed: false, detail: 'the chain refused it'}
  }
  return {
    txHash: outcome.txHash,
    stage: 'submitted',
    landed: null,
    detail:
      confirmation === 'pending'
        ? 'broadcast, and the chain has not decided yet — do not treat this as landed'
        : 'broadcast, and this wallet cannot currently tell whether it landed',
  }
}
