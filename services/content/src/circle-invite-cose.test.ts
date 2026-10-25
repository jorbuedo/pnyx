// The invite challenge's signature, signed the way the app signs it and verified the way the route
// verifies it — both production implementations, no re-derivation of either.
//
// ⚠️ **This shape has never run anywhere else.** Every other CIP-8 caller in the app signs for an
// *enterprise* address; an invite request signs for a **reward** address, because control of the
// stake credential is what makes `account_info`'s delegation and balance mean anything. The pure-ts
// corpus covers a reward address only under `verifyData` (P2, plus P1 only if the header claims one);
// this path uses `verifyDataForAddress`, where P1 is mandatory and the address is the one the *caller*
// names. If a live claim ever fails at the signature check, this is the binding to suspect, so it is
// pinned here rather than left to the first person who tries it.
//
// Two halves, and the whole point is that **both** are required:
//   P1+P2  — `Cose.verifyDataForAddress`: the signature is valid AND the key owns that reward address
//   payload — `coseSign1PayloadIs`: the signed bytes are the challenge we issued
// P2 alone would accept any signature this wallet ever produced, which for a Cardano stake key
// includes the Koios and SteelSwap challenges.
import { describe, expect, it } from 'vitest';
import {type AddressHex, type XprvHex} from '@evolution-sdk/review/Brands'
import {Address, Keys} from '@pnyx/cardano-core'
import {Cose} from '@pnyx/cardano-core';
import { Effect } from 'effect';
import { inviteChallengePayload } from './circle-invite-policy.js';
import { createInviteAttestorPorts } from './circle-invite-worker.js';

/** The route's own verifier. The Koios and mint links are never touched by `verify`. */
const attestor = createInviteAttestorPorts({
  koiosUrl: 'https://koios.invalid',
  mintLink: { url: 'https://sponsor.invalid', token: 'unused', network: 'preprod' },
});

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

const utf8ToHex = (text: string): string =>
  Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * A stake key and the reward address it owns — the app's shape: CIP-1852 role **2** (staking) at
 * account 0, and the reward address built from that key's hash.
 */
const stakeKey = async (mnemonic: string) => {
  const root = await run(Keys.rootKeyFromMnemonic(mnemonic));
  const xprv = await run(Keys.deriveCip1852(root, 0, 2, 0));
  const pub = await run(Keys.publicKey(xprv));
  const hash = await run(Keys.keyHash(pub));
  return { xprv, rewardHex: Address.rewardHex(Address.Network.Mainnet, hash) };
};

const ABANDON = `${'abandon '.repeat(11)}about`;
// BIP-39's second English test vector. A real phrase, because `rootKeyFromMnemonic` checks the
// checksum — `legal × 11 + will` fails as "bad checksum" rather than deriving a different key.
const OTHER = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

const CHALLENGE = inviteChallengePayload({ circleId: 'c1', nonce: 'n1', expiresAtMs: 1_800_000_000_000 });

/** Exactly what `circle-invite-request.ts` produces: `includeKid: true`, over the challenge string. */
const signChallenge = async (key: { xprv: XprvHex; rewardHex: AddressHex }, payload = CHALLENGE) =>
  run(Cose.signData(key.xprv, key.rewardHex, utf8ToHex(payload), true));

describe('an invite challenge signed for a reward address', () => {
  it('verifies against the reward address it was signed for', async () => {
    const key = await stakeKey(ABANDON);
    const sig = await signChallenge(key);
    expect(
      await attestor.verify({
        signatureHex: sig.signature,
        keyHex: sig.key,
        addressHex: key.rewardHex,
        expectedPayload: CHALLENGE,
      }),
    ).toBe(true);
  });

  // ⚠️ The half that makes this challenge mean *this* challenge. A wallet's stake key signs plenty of
  // other things; without the payload comparison any of them would open every gated circle.
  it('refuses a valid signature over a different challenge', async () => {
    const key = await stakeKey(ABANDON);
    const sig = await signChallenge(key, inviteChallengePayload({ circleId: 'c1', nonce: 'n2', expiresAtMs: 1 }));
    expect(
      await attestor.verify({
        signatureHex: sig.signature,
        keyHex: sig.key,
        addressHex: key.rewardHex,
        expectedPayload: CHALLENGE,
      }),
    ).toBe(false);
  });

  // ⚠️ The half that makes it about *this wallet*. The address passed here is the one the predicate is
  // about to be evaluated against, so a signature that does not own it must not pass — otherwise
  // anyone could claim against a stake address that qualifies and is not theirs.
  it('refuses a valid signature presented for somebody else’s reward address', async () => {
    const mine = await stakeKey(ABANDON);
    const theirs = await stakeKey(OTHER);
    const sig = await signChallenge(mine);
    expect(
      await attestor.verify({
        signatureHex: sig.signature,
        keyHex: sig.key,
        addressHex: theirs.rewardHex,
        expectedPayload: CHALLENGE,
      }),
    ).toBe(false);
  });

  // A malformed signature is an ordinary bad request, and must come back as `false` rather than
  // throwing into a route that has already consumed the caller's nonce.
  it('refuses malformed bytes without throwing', async () => {
    const key = await stakeKey(ABANDON);
    expect(
      await attestor.verify({ signatureHex: 'aabb', keyHex: 'ccdd', addressHex: key.rewardHex, expectedPayload: CHALLENGE }),
    ).toBe(false);
  });

  // The two mnemonics have to be different keys for the test above to mean anything.
  it('derives distinct reward addresses for distinct mnemonics', async () => {
    expect((await stakeKey(ABANDON)).rewardHex).not.toBe((await stakeKey(OTHER)).rewardHex);
  });
});
