/**
 * What an agent is told when its transaction reaches the person's review.
 *
 * Its own module because the shape is the contract — every builder's submit path answers through it —
 * and because `cardano-building.ts` cannot be imported by a test: it reaches the review screen, which
 * reaches React. Nothing here does.
 *
 * ⚠️ **The answer goes out at the hand-off and the outcome never follows it.** A submit path used to
 * hold the agent's call open through the decision and the broadcast, and lost the answer to a race it
 * could not win: approving navigates to `/wallets`, which unmounts the agents screen, which stops
 * serving and closes the relay socket — so the reply for a transaction that had already landed was
 * written to a socket that was gone, and the agent was told the wallet was not connected for a transfer
 * that was on chain. An agent acting on that asks the person to approve the same payment twice.
 *
 * @module
 */

import type {LocalToolOutcome} from '@pnyx/mcp-server'

/**
 * The sentence an agent gets with every hand-off.
 *
 * ⚠️ **It says what to do, not just what happened.** A model shown `awaitingApproval: true` and nothing
 * else reports the payment as made, or builds it again when no outcome arrives — the two failures this
 * whole shape exists to prevent, and both of them cost the person money or a second approval.
 */
export const HANDED_NOTE =
  'This is on the person’s device now, waiting for them to approve or decline it — the decision is ' +
  'theirs and this call does not wait for it. If they approve, it goes out under the transaction hash ' +
  'above. **Call cardano_listOutcomes to find out what they decided** — it says whether it was ' +
  'approved, declined or never submitted, and whether the chain has it. Do not build it again.'

/**
 * What every submit path answers with: the transaction is now the person's to decide.
 *
 * ⚠️ **`submitted` is deliberately absent rather than `false`.** The unsigned path already means
 * "nothing happened and here are the bytes", and reusing its word for "it is being approved right now"
 * would collapse two states an agent has to tell apart.
 */
export const handedAnswer = (value: Record<string, unknown>): LocalToolOutcome => ({
  ok: true,
  // The two keys that carry the contract go *after* the spread: a builder's own fields describe what it
  // built, and none of them may soften what the agent is told about the state it is in.
  value: {...value, awaitingApproval: true, note: HANDED_NOTE},
})
