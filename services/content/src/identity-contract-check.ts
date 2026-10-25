// What a host must satisfy itself of before it believes an `authPub` read from a contract the *caller*
// named.
//
// There is one identity contract per identity, at an address derived from `C`, so no host can have a
// single address configured — and a server cannot derive one either: the derivation needs the deploy
// machinery, which the Worker's decode-only wasm deliberately excludes. So a login names its contract,
// and these two rules are what make that safe:
//
//   1. the contract is built from **our** identity template (its code digest), and
//   2. it is sealed to **this** `C` (enforced inside the decoder, which errors otherwise).
//
// Together they are sufficient, and the reason is in the contract: `publishRow` asserts
// `identityCommitment(identitySk()) == id`, so a row can only be written by the holder of the identity
// the contract is sealed to. An attacker may deploy our template sealed to somebody else's `C` — and
// then it stays empty, because they cannot write to it. They may deploy their own code with any
// `authPub` they like — and rule 1 refuses it.
//
// Pure, and its own module, because it is the whole security argument of the login path and belongs
// somewhere it can be read and tested without a wasm module or a Worker runtime.

/** Why a named contract cannot be used, or `undefined` when it can. */
export type ContractRefusal = string | undefined;

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * Check the address a login named, before anything is fetched.
 *
 * Shape only — the digest is not knowable until the state is read. Kept separate so a malformed address
 * costs an argument check rather than an indexer round trip.
 */
export const refuseContractAddress = (contract: string | undefined): ContractRefusal => {
  if (contract === undefined || contract === '') {
    return 'a login must name this identity’s contract';
  }
  return HEX64.test(contract) ? undefined : 'the named contract is not 64 hex characters';
};

/**
 * Check the contract found there is one of ours.
 *
 * ⚠️ An unconfigured expectation is the empty string and so is a digest we failed to read, so the two
 * would compare equal and accept anything. Refused explicitly — the same hole the sponsorship policy
 * has to close for its own digests.
 */
export const refuseContractTemplate = (options: {
  readonly digest: string;
  readonly expected: string | undefined;
}): ContractRefusal => {
  if (options.expected === undefined || options.expected === '') {
    return 'this deployment has no identity template configured, so it cannot recognise any contract';
  }
  if (options.digest === '') {
    return 'the contract’s code digest could not be read';
  }
  return options.digest.toLowerCase() === options.expected.toLowerCase()
    ? undefined
    : 'the named contract is not built from this deployment’s identity template';
};
