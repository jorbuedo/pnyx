// Does this transaction belong to the network this wallet holds?
//
// ⚠️ **Because the answer arrived far too late.** On 2026-08-28 two submissions were accepted with a 202
// and then failed inside `balanceTx`, minutes later, as
// `invalid network ID - expect 'preview' found 'preprod'` — the ledger's own words, in the sponsor's
// journal, where no caller could ever see them. The ledger's verdict is authoritative and stays
// authoritative; this only moves the *obvious* cases to before the acceptance, where a caller can act.
//
// ⚠️ **What this proves, and what it does not.** A serialized `StandardTransaction` carries its
// `network_id` as a plain UTF-8 string, so the bytes of a preview transaction contain `preview`. The
// check is therefore **one-sided**:
//
// - the name is absent → these bytes are certainly *not* for that network. Refused, and it is safe to
//   refuse, because no encoding of that network's id omits its own name.
// - the name is present → probably right, and not proven: the same bytes could hold it by coincidence
//   somewhere else. Accepted, and the ledger still has the last word at balance time.
//
// That asymmetry is why this is a guard and not a validation, and why it must never be described as
// having verified anything. It exists to convert a silent late failure into an early named refusal.
//
// It is deliberately **not** a deserialize. The JS ledger bindings expose no `networkId` accessor on
// `Transaction` at all (checked against `ledger-v8.d.ts`) — the same gap that keeps
// `MidnightTxFacts.networkId` fillable only by the native reader — so there is no exact JS answer to be
// had here, at any cost.

/** Every Midnight network id that can appear in a transaction, so a foreign one can be named. */
const KNOWN_NETWORKS = ['mainnet', 'preprod', 'preview', 'undeployed'] as const;

export type NetworkGuardVerdict =
  /** The bytes do not name this network. Refuse, naming another one when it is recognisable. */
  | { readonly ok: false; readonly message: string }
  /** The bytes name this network — as far as this check can tell. */
  | { readonly ok: true };

const asciiOf = (bytes: Uint8Array): string => {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
};

/**
 * Refuse a transaction that plainly belongs to another network.
 *
 * `expected` is this wallet's own `MIDNIGHT_NETWORK`. An unknown `expected` (a network id this module
 * does not list) is **accepted unchecked** rather than refused: a new network id is a thing to add here,
 * not a reason for a host configured for it to reject all of its own traffic.
 */
export const guardNetwork = (txBytes: Uint8Array, expected: string): NetworkGuardVerdict => {
  if (!(KNOWN_NETWORKS as readonly string[]).includes(expected)) return { ok: true };
  // Only the tail carried the id in every sample seen so far, but the whole body is cheap at these
  // sizes and a position assumption is the kind that breaks on a shape nobody tested.
  const text = asciiOf(txBytes);
  if (text.includes(expected)) return { ok: true };
  const foundInstead = KNOWN_NETWORKS.filter((one) => one !== expected && text.includes(one));
  const instead = foundInstead.length === 0 ? '' : `; these name ${foundInstead.join(' and ')}`;
  return {
    ok: false,
    message:
      `this sponsor holds ${expected} and these bytes are not a ${expected} transaction${instead}. ` +
      'Submit to the sponsor for the network the transaction was built for.',
  };
};
