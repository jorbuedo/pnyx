// Round-trips against the real signer: the fixtures are COSE_Sign1 messages produced by
// the real COSE signer, not hand-rolled CBOR. A hand-built fixture would
// only prove this file agrees with my idea of the format, which is the thing in doubt.

import {Address, Keys} from '@pnyx/cardano-core'
import {Cose} from '@pnyx/cardano-core';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { coseSign1Payload, coseSign1PayloadIs } from './cose-payload.js';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const toHex = (bytes: Uint8Array): string => {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
};

/** Sign `payload` with a throwaway key, returning the COSE_Sign1 bytes. */
const sign = async (payload: string): Promise<Uint8Array> => {
  const program = Effect.gen(function* () {
    const root = yield* Keys.rootKeyFromMnemonic(MNEMONIC);
    const payment = yield* Keys.deriveCip1852(root, 0, 0, 0);
    const stake = yield* Keys.deriveCip1852(root, 0, 2, 0);
    const paymentHash = yield* Keys.keyHashOf(payment);
    const stakeHash = yield* Keys.keyHashOf(stake);
    const addressHex = Address.baseHex(Address.Network.Mainnet, paymentHash, stakeHash);
    const sig = yield* Cose.signData(payment, addressHex, toHex(new TextEncoder().encode(payload)));
    return fromHex(sig.signature);
  });
  return Effect.runPromise(
    program as unknown as Effect.Effect<Uint8Array>,
  );
};

describe('coseSign1Payload', () => {
  it('reads back exactly what the real signer signed', async () => {
    const payload = 'pnyx-bug-report.v1.1757000000000.nonce_0123456789abcdef.' + 'a'.repeat(64);
    const sign1 = await sign(payload);

    expect(coseSign1Payload(sign1)).not.toBeNull();
    expect(new TextDecoder().decode(coseSign1Payload(sign1) as Uint8Array)).toBe(payload);
  });

  it('handles an empty payload without confusing it for a parse failure', async () => {
    const sign1 = await sign('');
    const payload = coseSign1Payload(sign1);

    // `null` means "unreadable"; a zero-length payload is readable and empty. Collapsing the
    // two would make an empty signed string look like a malformed message.
    expect(payload).not.toBeNull();
    expect((payload as Uint8Array).length).toBe(0);
  });

  it('returns null for input that is not a COSE_Sign1', () => {
    expect(coseSign1Payload(new Uint8Array(0))).toBeNull();
    expect(coseSign1Payload(new Uint8Array([0x01, 0x02, 0x03]))).toBeNull();
    // A CBOR array of the wrong arity is structurally close but not this format.
    expect(coseSign1Payload(new Uint8Array([0x83, 0x40, 0xa0, 0x40]))).toBeNull();
  });

  it('returns null when the truncation reaches the payload, rather than throwing', async () => {
    const sign1 = await sign('a-payload-long-enough-to-cut-into');

    expect(coseSign1Payload(sign1.slice(0, 12))).toBeNull();
    expect(coseSign1Payload(sign1.slice(0, 3))).toBeNull();
  });

  // Not a gap: this function extracts, it does not judge. Signature validity belongs to
  // `Cose.verifyDataForAddress`, and a verifier calls both — so a message whose signature was
  // mangled still yields its payload here and is refused there.
  it('still reads the payload when only the trailing signature is damaged', async () => {
    const payload = 'still-readable';
    const sign1 = await sign(payload);
    const clipped = sign1.slice(0, sign1.length - 10);

    expect(coseSign1Payload(clipped)).not.toBeNull();
    expect(new TextDecoder().decode(coseSign1Payload(clipped) as Uint8Array)).toBe(payload);
  });
});

describe('coseSign1PayloadIs', () => {
  // ⚠️ The check that stops a cross-protocol replay. The same identity key signs the Koios and
  // SteelSwap challenges; `Cose.verifyDataForAddress` would accept either, because it never
  // looks at the content. This is the half that does.
  it('accepts the expected string and rejects any other', async () => {
    const expected = 'pnyx-bug-report.v1.1757000000000.nonce_0123456789abcdef.' + 'a'.repeat(64);
    const sign1 = await sign(expected);

    expect(coseSign1PayloadIs(sign1, expected)).toBe(true);
    expect(coseSign1PayloadIs(sign1, `${expected} `)).toBe(false);
    expect(coseSign1PayloadIs(sign1, expected.replace('bug-report', 'something-else'))).toBe(false);
    expect(coseSign1PayloadIs(sign1, 'a-koios-challenge-nonce')).toBe(false);
  });

  it('rejects rather than passing when the message cannot be parsed', () => {
    expect(coseSign1PayloadIs(new Uint8Array([0xff]), 'anything')).toBe(false);
  });
});
