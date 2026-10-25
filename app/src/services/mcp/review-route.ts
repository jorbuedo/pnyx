/**
 * Where a review ticket is opened, per chain.
 *
 * ⚠️ **Its own module because getting it wrong is silent.** The route is passed to
 * `router.push(… as never)`, so a wrong or misspelled path is not a type error — it is a screen that
 * renders something else. On 2026-08-28 the agent surface hardcoded the Cardano route for every
 * builder, and the first co-funded *Midnight* build reached the Cardano review with an id it could not
 * resolve: a built, signed, correct transaction reported to the agent as "Transaction failed".
 *
 * The chain being a required parameter is what stops that shape recurring. `review-route.test.ts`
 * pins each path against the route file that actually serves it, which is the half a type cannot check.
 *
 * @module
 */

/** The chains that have a review screen an agent can be sent to. */
export type ReviewChain = 'cardano' | 'midnight'

/**
 * The href for a ticket.
 *
 * ⚠️ The query parameter differs per chain and is not incidental: the Cardano review reads `ticket`
 * and the Midnight ones read `dapp`, because they are separate handoff registries with separate id
 * spaces. A Cardano id under `dapp` would resolve to nothing.
 */
export const reviewRouteFor = (chain: ReviewChain, ticketId: string): string =>
  chain === 'cardano' ? `/wallet/review-tx?ticket=${ticketId}` : `/wallet/midnight/transaction?dapp=${ticketId}`
