/**
 * Which wallet a painted list belongs to.
 *
 * Balance rows are asynchronous and arrive from three writers — a cache read, a live
 * enrichment, and a post-sync re-enrichment — none of which clears state when the selected
 * wallet changes, and one of which is *designed* not to (the prices-unavailable branch keeps
 * whatever is already painted rather than blanking a known balance).
 *
 * So the wallet switch showed the previous wallet's balance under the new wallet's name,
 * with `loading` false because a fetch had in fact settled — just not this one's. Seen as a
 * shared wallet reporting 78 tADA that belonged to the wallet selected before it.
 *
 * The rule is therefore structural rather than an effect ordering, because an effect
 * ordering is exactly what failed: **rows carry the wallet they describe, and rows for
 * another wallet are not rows.** A stale scope reads as empty and loading, which is the
 * truth — nothing has been fetched for this wallet yet.
 *
 * Shared by the portfolio and the activity list. They diverged before this was shared: on a
 * switch one blanked to skeletons and the other went on showing the previous wallet's
 * transactions, so the same screen told the user two different things about whose data it was.
 *
 * @module
 */

/** A payload and the wallet it describes. */
export type WalletScoped<T> = {readonly key: string; readonly rows: readonly T[]}

/**
 * The identity a list is scoped to.
 *
 * Account index is part of it: two accounts of one wallet are different balances, and
 * keying on the group alone would let a switch between them show the wrong one.
 *
 * So is the network, when the caller knows it — the same wallet on preprod and on mainnet has
 * entirely different balances and history, and a key that ignored it would carry one network's
 * rows straight into the other.
 */
export const walletScopeKey = (groupId: string | null, accountIndex: number, network?: string | number): string =>
  `${groupId ?? ''}:${accountIndex}${network === undefined ? '' : `:${network}`}`

/** Whether nothing has been painted for `key` yet — an unfetched wallet, not an empty one. */
export const isStaleScope = <T>(painted: WalletScoped<T>, key: string): boolean => painted.key !== key

/**
 * The rows to render for `key`, which is `empty` whenever the painted set is another
 * wallet's.
 *
 * `empty` is passed in so the caller can keep one stable identity and not re-render every
 * consumer on each miss.
 */
export const rowsForScope = <T>(painted: WalletScoped<T>, key: string, empty: readonly T[]): readonly T[] =>
  isStaleScope(painted, key) ? empty : painted.rows

/**
 * Apply an update in `key`'s scope.
 *
 * An updater function sees the *current wallet's* rows, never the previous wallet's — which
 * is what makes "keep what is already painted" safe: it can only keep this wallet's.
 */
export const writeScoped = <T>(
  painted: WalletScoped<T>,
  key: string,
  next: readonly T[] | ((prev: readonly T[]) => readonly T[]),
  empty: readonly T[],
): WalletScoped<T> => ({
  key,
  rows: typeof next === 'function' ? next(rowsForScope(painted, key, empty)) : next,
})
