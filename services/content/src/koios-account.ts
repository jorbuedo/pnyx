// Read a stake account's delegation and balance from the configured Koios rail.
//
// The attestor's only outbound chain read. All four first-round predicates — delegates to a named
// DRep, delegates to any DRep, is in a named pool, holds a threshold of ADA — are answered by this
// one call, which is why they are the set we start with.
//
// ⚠️ **The URL is configuration, never a default.** The repo's third-party RPC policy forbids
// reaching for a public Koios instance when none is configured: an endpoint we do not operate is
// rate-limited, shared, and out of our control, and quietly substituting one turns a deployment
// mistake into intermittent wrong answers. `KOIOS_URL` unset means the self-service invite route
// does not exist on that deployment, which the route reports as such.
//
// Deliberately not shared with the app's `services/cardano/koios-request.ts`: same endpoint, two
// deployables with different runtimes, and neither can import the other without a new package —
// the same call `midnight-indexer.ts` makes about the Midnight indexer.

import type { AccountFacts } from './circle-invite-policy.js';

/** What `/account_info` returns, narrowed to the fields any predicate reads. */
type KoiosAccountRow = {
  stake_address?: string;
  status?: string;
  delegated_pool?: string | null;
  delegated_drep?: string | null;
  total_balance?: string | null;
};

export type AccountLookup =
  /** The chain answered. `facts` is null when it has never seen this stake address. */
  | { readonly ok: true; readonly facts: AccountFacts | null }
  /** We could not ask. Distinct from "not registered" — one is the user's problem, one is ours. */
  | { readonly ok: false; readonly error: string };

/**
 * Fetch one stake account's facts.
 *
 * ⚠️ **"Koios refused" and "this key is not registered" must not collapse into one answer.** The
 * first is an outage the requester can do nothing about and should retry; the second is a real
 * verdict about their wallet. Returning `null` facts for both would tell someone their stake key
 * is unregistered because our provider was rate-limited.
 */
export const fetchAccountFacts = async (
  koiosUrl: string,
  stakeAddress: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AccountLookup> => {
  let response: Response;
  try {
    response = await fetchImpl(`${koiosUrl.replace(/\/$/, '')}/account_info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _stake_addresses: [stakeAddress] }),
    });
  } catch (error) {
    return { ok: false, error: `koios unreachable: ${String(error)}` };
  }
  if (!response.ok) {
    return { ok: false, error: `koios ${response.status}` };
  }
  let rows: unknown;
  try {
    rows = await response.json();
  } catch (error) {
    return { ok: false, error: `koios returned unreadable json: ${String(error)}` };
  }
  if (!Array.isArray(rows)) {
    return { ok: false, error: 'koios returned a non-array' };
  }
  const row = rows[0] as KoiosAccountRow | undefined;
  if (row === undefined) {
    // An empty array is Koios saying it has no such account, which is a real answer.
    return { ok: true, facts: null };
  }
  return { ok: true, facts: accountFactsFrom(row) };
};

/**
 * Map one Koios row onto the facts a predicate reads.
 *
 * Exported for the tests, which is worth more than keeping it private: this mapping is where a
 * field rename upstream turns every gated circle into one nobody can join, and it is pure.
 *
 * ⚠️ **`total_balance` absent stays absent.** It becomes `null`, not `0n`: a balance we failed to
 * read and a balance of nothing are different facts, and `accountSatisfies` refuses the first with
 * its own reason rather than telling a whale they are below the threshold.
 */
export const accountFactsFrom = (row: KoiosAccountRow): AccountFacts => ({
  // Koios reports `registered` / `not registered` / `rewards` / `delegated`; only the first is a
  // definite "this key has never been seen". Anything else means the chain knows it.
  registered: row.status !== undefined && row.status !== 'not registered',
  delegatedPool: row.delegated_pool ?? null,
  delegatedDrep: row.delegated_drep ?? null,
  controlledBalance:
    row.total_balance === undefined || row.total_balance === null || !/^[0-9]+$/.test(row.total_balance)
      ? null
      : BigInt(row.total_balance),
});
