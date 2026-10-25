// Read a Midnight contract's serialized state from an indexer.
//
// The Worker's substitute for a chain mirror. It cannot run one — a mirror needs a funded, synced,
// stateful host — but reading state is a single GraphQL query, and reading a row is that plus the
// wasm decode in `row-decoder.ts`. That covers login, which only ever reads.
//
// Deliberately not shared with the app's `services/midnight/contract-state.ts`: same query, but the
// two are separate deployables with separate runtimes and neither can import the other without a new
// package. If a third consumer appears, extract one.

/** There is no read-one-key query on Midnight — a contract's ledger is a single blob. */
const STATE_QUERY = `query State($address: HexEncoded!) {
  contractAction(address: $address) {
    state
  }
}`;

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

type Reply = {
  data?: { contractAction?: { state?: string } | null };
  errors?: readonly { message: string }[];
};

/**
 * Where to read, and what to authenticate with.
 *
 * ⚠️ **The two travel together.** Blockfrost serves preprod and answers 403 without a key, so a URL
 * without its `projectId` is not a usable endpoint — passing them as one argument is what stops a
 * call site from carrying only half the configuration. The key goes in a **header**, never in the
 * query string: a URL reaches logs, error messages and, through the connector's `configuration`,
 * connected dApps.
 */
export type IndexerEndpoint = {
  readonly url: string;
  /** Blockfrost's `project_id`. Absent for an indexer that needs no key, like our own. */
  readonly projectId?: string;
};

/**
 * The contract's current state, or `undefined` when the contract has no actions yet.
 *
 * Throws on transport or GraphQL failure, so the caller can tell "nothing deployed there" from "we
 * could not look" — login reports the second as an outage rather than as an unregistered identity.
 */
export const fetchContractState = async (
  indexer: IndexerEndpoint,
  contractAddress: string,
): Promise<Uint8Array | undefined> => {
  const response = await fetch(indexer.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Lowercase with an underscore, exactly as Blockfrost names it: `Project-Id` is a different
      // header to their gateway and answers 403 (measured 2026-10-13).
      ...(indexer.projectId === undefined ? {} : { project_id: indexer.projectId }),
    },
    body: JSON.stringify({ query: STATE_QUERY, variables: { address: contractAddress } }),
  });
  if (!response.ok) {
    throw new Error(`indexer responded ${response.status}`);
  }
  const reply = (await response.json()) as Reply;
  if (reply.errors !== undefined && reply.errors.length > 0) {
    throw new Error(reply.errors.map((e) => e.message).join('; '));
  }
  const state = reply.data?.contractAction?.state;
  return state === undefined || state === null ? undefined : fromHex(state);
};
