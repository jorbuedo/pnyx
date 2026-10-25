/**
 * Whether a chain is one that keeps a `WalletSnapshot` at all.
 *
 * `loadCachedChainSnapshot` returns `null` both when a snapshot is missing and when the chain never had
 * one, and `applySyncResult` warned on either — so every Midnight sync logged *"Sync produced no
 * snapshot — skipping state update"* once a minute, for ever, describing the design rather than a
 * fault. A warning that fires unconditionally for a whole chain family is not a signal, and it buried
 * the case where the same line is real: Cardano, where a missing snapshot means the rail failed to
 * write one and the surfaces reading it are stale.
 *
 * Only the Cardano rail calls `saveSnapshot` (`services/cardano/rail.ts`). Midnight keeps its state in
 * its own stores — the unshielded cache, the shielded state, the DUST state — and derive-only chains
 * hold addresses and no balances. For those, no snapshot is the correct outcome and not news.
 *
 * A pure predicate in its own module so the distinction is stated once and can be tested, rather than
 * inlined as a family check somebody later reads as arbitrary.
 *
 * @module
 */

import type {ChainId} from '@pnyx/config'

/**
 * `true` when a sync that produced no snapshot is worth reporting.
 *
 * Deliberately an allowlist of one rather than a denylist: a chain family added later keeps its own
 * state until somebody teaches it to write snapshots, so silence is the right default and the wrong
 * answer here is a log line, not a lost balance.
 *
 * ⚠️ **Reads the prefix rather than calling `getChainFamily`, which throws** on any chain id it does
 * not enumerate — including `cardano:preprod`. Deciding a *log level* is no place to raise, and this
 * sits directly in the sync path, so an unknown chain must fall through to "not expected" rather than
 * take the sync down with it. Caught by this module's own test.
 */
export const chainKeepsSnapshots = (chainId: ChainId): boolean => String(chainId).startsWith('cardano:')
