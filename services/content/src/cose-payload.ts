// Read the payload out of a COSE_Sign1, so a verifier can check *what* was signed.
//
// ## Why this exists
//
// `Cose.verifyDataForAddress` answers "is this signature valid, and does the key own this
// address" — and nothing about the content. A verifier that stops there accepts any signature
// that address ever produced, which for our identity key includes the Koios and SteelSwap
// challenges. Comparing the payload is the second half of the check, and there is no exported
// API that does it: the COSE tier exposes `verifyDataForAddress` (no `externalAad` parameter)
// and keeps its `Sign1` parser private.
//
// ⚠️ **This is not a copy of that private parser.** It reads element 2 of a published,
// standardised structure using the CBOR primitives that ARE exported, and it
// deliberately does not re-implement signature checking, header parsing or address binding —
// those stay with `Cose.verifyDataForAddress`, which remains the only thing verifying
// anything. If the submodule ever exposes an `externalAad`-capable verify, this file should be
// deleted in favour of it: binding via `Sig_structure` leaves nothing for a caller to forget.
//
// COSE_Sign1 = [ protected: bstr, unprotected: map, payload: bstr, signature: bstr ]
// optionally wrapped in CBOR tag 18 (RFC 8152 §4.2).

import * as Cbor from '@evolution-sdk/evolution/CBORBuilder';

/** CBOR major type 2 — byte string. */
const MAJOR_BSTR = 2;
/** CBOR major type 4 — array. */
const MAJOR_ARRAY = 4;
/** CBOR major type 6 — tag. */
const MAJOR_TAG = 6;
/** RFC 8152's COSE_Sign1 tag. */
const COSE_SIGN1_TAG = 18n;

/**
 * The signed payload bytes, or `null` when `sign1` is not a well-formed COSE_Sign1.
 *
 * `null` rather than a throw: a malformed signature is an ordinary bad request, and a verifier
 * that has to wrap this in try/catch will eventually forget to.
 */
export const coseSign1Payload = (sign1: Uint8Array): Uint8Array | null => {
  try {
    let pos = 0;
    const [tagHead, tagValue, tagMajor] = Cbor.readHead(sign1, pos);
    if (tagMajor === MAJOR_TAG) {
      // A tag that is not 18 is some other COSE structure; refusing beats guessing.
      if (tagValue !== COSE_SIGN1_TAG) return null;
      pos += tagHead;
    }

    const [arrayHead, arrayLen, arrayMajor] = Cbor.readHead(sign1, pos);
    if (arrayMajor !== MAJOR_ARRAY || arrayLen !== 4n) return null;
    pos += arrayHead;

    // Element 0: protected headers, a bstr. Skipped — `Cose.verifyDataForAddress` is what reads
    // the address claim out of it, and duplicating that here would be the copy this file is
    // careful not to be.
    const [protHead, protLen, protMajor] = Cbor.readHead(sign1, pos);
    if (protMajor !== MAJOR_BSTR) return null;
    pos += protHead + Number(protLen);

    // Element 1: unprotected headers, a map of unknown shape. `itemLen` skips it whole.
    pos += Cbor.itemLen(sign1, pos);

    // Element 2: the payload.
    const [payloadHead, payloadLen, payloadMajor] = Cbor.readHead(sign1, pos);
    if (payloadMajor !== MAJOR_BSTR) return null;
    const start = pos + payloadHead;
    const end = start + Number(payloadLen);
    if (end > sign1.length) return null;
    return sign1.slice(start, end);
  } catch {
    // `readHead` throws on truncated input. That is a malformed request, and the caller's
    // contract is `null` — logging here would fire on every fuzzed byte a public route sees.
    return null;
  }
};

/**
 * Whether `sign1` carries exactly `expected` as its payload.
 *
 * Compares decoded UTF-8 rather than bytes, because the expected value is a canonical *string*
 * and a caller holding one should not have to encode it correctly to get a safe answer. Both
 * sides are public values — the digest and a nonce — so there is nothing here to leak through
 * timing.
 */
export const coseSign1PayloadIs = (sign1: Uint8Array, expected: string): boolean => {
  const payload = coseSign1Payload(sign1);
  if (payload === null) return false;
  return new TextDecoder().decode(payload) === expected;
};
