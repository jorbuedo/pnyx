/**
 * Tokens the wallet used to hold and does not any more.
 *
 * Sold out of a position and the token disappears from the portfolio, taking its price chart and its
 * transaction history with it — even though both still describe something that happened to this
 * wallet's money. The balance timeline knows every asset ever touched, so the list is derivable with
 * no extra data source.
 *
 * "Past" means exactly *held then, not now*: a positive balance at some point in the local history,
 * and nothing held today. An asset that only ever passed through with a zero net position never
 * qualifies.
 *
 * @module
 */

import {ADA_KEY, type BalanceTimeline} from './balance-timeline'

/** A token no longer held, with the instant it was last held. */
export type PastToken = {
  readonly assetKey: string
  /** Unix seconds of the last step where the balance was still positive. */
  readonly lastHeldSec: number
}

/**
 * Assets in `timeline` that were once held with a positive balance and are absent from `heldNow`,
 * most recently held first.
 *
 * ADA is excluded: the wallet's own unit is not a position you exit, and a zero ADA balance is an
 * empty wallet rather than a past holding.
 *
 * `heldNow` is the set of asset keys with a positive balance today. Passing the *current* holdings
 * rather than reading the timeline's tip is deliberate — the tip is only reliable once history is
 * complete from genesis, and a freshly imported wallet's is not.
 *
 * ⚠️ **Absent from `heldNow` is not the same as exited, and the two sources must agree.** `heldNow`
 * is built from the rail's *spendable* view, which is `confirmed − locked + virtual change`. Sending
 * to yourself locks every input the asset was in, and the output that carries it back is a *payment*,
 * not change — so it is in neither term, and the asset vanishes from the balance for as long as
 * confirmation takes while the wallet demonstrably still holds it. The timeline is the second
 * opinion: a self-send nets to a zero `ownDelta`, so its running balance never dips. When the tip is
 * still positive the wallet has no evidence of an exit, and the honest answer is to say nothing
 * rather than to file a token the user just received under "no longer held".
 *
 * The veto is one-directional on purpose. A tip that is positive is trustworthy — partial history
 * truncates the *old* end, so a missing early receive can only push the tip too low, never too high.
 * A tip at or below zero is not trusted on its own, which is why `heldNow` remains the primary test.
 */
export const pastTokens = (timeline: BalanceTimeline, heldNow: ReadonlySet<string>): readonly PastToken[] => {
  const out: PastToken[] = []
  for (const [key, steps] of timeline) {
    if (key === ADA_KEY || heldNow.has(key)) continue
    // The wallet's own deltas still show a balance: the rail cannot see it yet, it was not exited.
    if ((steps[steps.length - 1]?.balance ?? 0n) > 0n) continue
    let lastHeldSec: number | null = null
    for (const step of steps) if (step.balance > 0n) lastHeldSec = step.ts
    if (lastHeldSec === null) continue
    out.push({assetKey: key, lastHeldSec})
  }
  return out.sort((a, b) => b.lastHeldSec - a.lastHeldSec)
}
