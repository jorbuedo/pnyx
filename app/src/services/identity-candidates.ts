/**
 * Candidate identities for the onboarding avatar picker.
 *
 * Each candidate is a **whole, independent identity**: its own 256-bit entropy from the CSPRNG, its
 * own BIP-39 mnemonic, its own `C`. Picking one from a grid does not weaken it — the seeds are
 * independently random, and choosing among them reveals nothing an attacker could use. What *would*
 * weaken them is deriving them all from one master by index, so each is generated on its own.
 *
 * **A candidate holds entropy, not a mnemonic.** A JS string cannot be wiped, so retaining N
 * mnemonics would leave N recovery phrases in the heap until GC with no way to clear them. The
 * mnemonic is materialised only long enough to derive `C`, then dropped; the caller re-materialises
 * exactly one — the chosen one — through {@link mnemonicForCandidate}. Entropy is a `Uint8Array`, so
 * discarded candidates can actually be zeroed ({@link discardCandidates}).
 *
 * The avatar is keyed on `C` and nothing else, because a peer holding only your public identity has
 * to render the same picture you do.
 *
 * @module
 */

import {encodePnyxId, identityCommitmentOf, identitySkFromForumRoot} from '@pnyx/contract-client/identity'
import {forumRoot} from '@pnyx/contract-client/persona'
import {randomBytes} from '@pnyx/crypto'
import {mnemonicToSeed} from '@pnyx/wallet'
import {entropyToMnemonic} from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'
import {Effect} from 'effect'

/** 256-bit entropy — a 24-word phrase, matching what Quick start has always generated. */
const ENTROPY_BYTES = 32

export type IdentityCandidate = {
  /** The only retained secret. Zeroable, unlike the mnemonic it produces. */
  readonly entropy: Uint8Array
  /** The public identity this entropy leads to; the avatar's seed. */
  readonly pnyxId: string
}

/**
 * The `pnyx_id` a mnemonic leads to. The same on every network — an identity names a person, not a
 * chain — so the avatar the user picks here is the avatar they keep.
 *
 * Cheap now (~1 ms — BIP-39's PBKDF2 goes through OpenSSL on device), and entirely offline: nothing
 * about an identity's public name requires a server, which is why the avatar must never wait on one.
 */
export const pnyxIdForMnemonic = async (mnemonic: string): Promise<string> => {
  const seed = await mnemonicToSeed(mnemonic)
  const root = forumRoot(seed)
  seed.fill(0)
  const identitySk = identitySkFromForumRoot(root)
  const pnyxId = encodePnyxId(identityCommitmentOf(identitySk))
  root.fill(0)
  identitySk.fill(0)
  return pnyxId
}

/** The mnemonic for a candidate the user actually chose. */
export const mnemonicForCandidate = (candidate: IdentityCandidate): string =>
  entropyToMnemonic(candidate.entropy, wordlist)

/**
 * Overwrite the entropy of candidates the user did not choose.
 *
 * Honest about its limits: this clears the arrays we hold, but each candidate's mnemonic *string*
 * and derived seed existed transiently inside {@link generateIdentityCandidates} and cannot be
 * unwritten from the heap. Zeroing what we can still shortens the window materially.
 */
export const discardCandidates = (candidates: readonly IdentityCandidate[]): void => {
  for (const candidate of candidates) candidate.entropy.fill(0)
}

/**
 * `count` fresh candidates.
 *
 * Cost is dominated by BIP-39's PBKDF2 — ~1 ms per candidate on device through
 * `react-native-quick-crypto`, but ~1.1 s each in a pure-JS build, so this must not be called on a
 * platform without the native path (see `packages/wallet/account/pbkdf2.native.ts`).
 */
export const generateIdentityCandidates = async (count: number): Promise<readonly IdentityCandidate[]> => {
  const candidates: IdentityCandidate[] = []
  for (let i = 0; i < count; i++) {
    // `@pnyx/crypto`'s CSPRNG rather than `expo-crypto`'s, so this module stays importable outside
    // the RN runtime and its tests can exercise the real generator instead of a copy of it.
    const entropy = Effect.runSync(randomBytes(ENTROPY_BYTES))
    // The mnemonic and seed are deliberately scoped to this iteration: nothing outside it can reach
    // them, so the only lasting reference to this identity is `entropy`.
    const pnyxId = await pnyxIdForMnemonic(entropyToMnemonic(entropy, wordlist))
    candidates.push({entropy, pnyxId})
  }
  return candidates
}
