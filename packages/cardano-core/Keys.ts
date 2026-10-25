// Key management — BIP-39 mnemonic → Icarus root → CIP-1852 derivation → sign,
// as an Effect facade over the byte-exact core. Every step is gated == CSL
// (see harness/differential.mjs; closes G6/G7).

import {
  Bip32PrivateKey,
  Bip32PublicKey,
  Bytes,
  Ed25519Signature,
  KeyHash,
  PrivateKey,
  VKey,
} from '@evolution-sdk/evolution'
import {XpubHex as asXpub, KeyHashHex, XprvHex, type XpubHex} from '@evolution-sdk/review/Brands'
import {mnemonicToEntropy as bip39MnemonicToEntropy} from '@scure/bip39'
import {wordlist as englishWordlist} from '@scure/bip39/wordlists/english.js'
import {Effect} from 'effect'
import {op} from './Op.js'

/** The hardened-index offset, `2^31`. Private: the two path builders below are the API. */
const HARDENED = 0x80000000

export const cip1852Path = (account: number, role: number, index: number): Array<number> => [
  (1852 | HARDENED) >>> 0,
  (1815 | HARDENED) >>> 0,
  (account | HARDENED) >>> 0,
  role,
  index,
]

/** CIP-1854 multisig path `m/1854'/1815'/account'/role/index`. */
export const cip1854Path = (account: number, role: number, index: number): Array<number> => [
  (1854 | HARDENED) >>> 0,
  (1815 | HARDENED) >>> 0,
  (account | HARDENED) >>> 0,
  role,
  index,
]
/** Derive a CIP-1854 (multisig) child key from a root xprv. */
export const deriveCip1854 = (rootXprvHex: XprvHex, account: number, role: number, index: number) =>
  derivePath(rootXprvHex, cip1854Path(account, role, index))

/**
 * BIP-39 phrase → entropy hex.
 *
 * ⚠️ Through `@scure/bip39` directly: Evolution consumes the same library for its own derivation
 * but exports no entropy accessor, so this is the call its `sdk/wallet/Derivation` makes.
 */
export const mnemonicToEntropy = (phrase: string) =>
  op('mnemonicToEntropy', () => Bytes.toHex(bip39MnemonicToEntropy(phrase, englishWordlist)))

export const rootKeyFromEntropy = (entropyHex: string, passwordHex = '') =>
  op('rootKey', () =>
    XprvHex(
      Bip32PrivateKey.toHex(Bip32PrivateKey.fromBip39Entropy(Bytes.fromHex(entropyHex), Bytes.fromHex(passwordHex))),
    ),
  )

/** BIP-39 phrase → Icarus root xprv (PBKDF2). Empty password by default. */
export const rootKeyFromMnemonic = (phrase: string, passwordHex = '') =>
  mnemonicToEntropy(phrase).pipe(Effect.flatMap((ent) => rootKeyFromEntropy(ent, passwordHex)))

export const derivePath = (xprvHex: XprvHex, path: ReadonlyArray<number>) =>
  op('derivePath', () =>
    XprvHex(Bip32PrivateKey.toHex(Bip32PrivateKey.derive(Bip32PrivateKey.fromHex(xprvHex), [...path]))),
  )

/** Derive the CIP-1852 child at `m/1852'/1815'/account'/role/index` from a root xprv. */
export const deriveCip1852 = (rootXprvHex: XprvHex, account: number, role: number, index: number) =>
  derivePath(rootXprvHex, cip1852Path(account, role, index))

/**
 * The account-level extended public key (xpub = pubkey ‖ chaincode, 128 hex) for
 * an account-level xprv. Neutered — safe to persist; feeds seedless CKDpub
 * discovery via `derivePublicPath` / `bip32PublicDerive`.
 */
export const accountXpubOf = (xprvHex: XprvHex) =>
  op('xpubFromXprv', () => asXpub(Bip32PublicKey.toHex(Bip32PrivateKey.toPublicKey(Bip32PrivateKey.fromHex(xprvHex)))))

/**
 * CKDpub — walk a NON-HARDENED path (e.g. `[role, index]`) from an account xpub,
 * yielding the child xpub (hex). Its first 64 hex are the child public key.
 */
export const derivePublicPath = (xpubHex: XpubHex, path: ReadonlyArray<number>) =>
  op('derivePublicPath', () =>
    asXpub(Bip32PublicKey.toHex(Bip32PublicKey.derivePath(Bip32PublicKey.fromHex(xpubHex), [...path]))),
  )

/**
 * The 32-byte Ed25519 public key, as a vkey witness carries it.
 *
 * ⚠️ **Not the xpub.** `Bip32PublicKey.toRawBytes` is the key alone; `toHex` — which
 * {@link accountXpubOf} returns — is 64 bytes, the key followed by its chain code. These are the
 * pair that gets confused, and a vkey witness built from the 64-byte form is not a witness.
 */
export const publicKeySync = (xprvHex: XprvHex): string =>
  Bytes.toHex(Bip32PublicKey.toRawBytes(Bip32PrivateKey.toPublicKey(Bip32PrivateKey.fromHex(xprvHex))))
/** The 28-byte hash of a 32-byte Ed25519 public key. See {@link publicKeySync} for the pairing. */
export const keyHashSync = (pubHex: string): KeyHashHex =>
  KeyHashHex(KeyHash.toHex(KeyHash.fromVKey(VKey.fromHex(pubHex))))

/** An Ed25519 signature over `messageHex` by an extended private key. */
export const signSync = (xprvHex: XprvHex, messageHex: string): string =>
  Ed25519Signature.toHex(
    PrivateKey.sign(Bip32PrivateKey.toPrivateKey(Bip32PrivateKey.fromHex(xprvHex)), Bytes.fromHex(messageHex)),
  )

export const publicKey = (xprvHex: XprvHex) => op('bip32Public', () => publicKeySync(xprvHex))
export const keyHash = (pubHex: string) => op('keyHash', () => keyHashSync(pubHex))
export const sign = (xprvHex: XprvHex, messageHex: string) => op('bip32Sign', () => signSync(xprvHex, messageHex))
export const keyHashOf = (xprvHex: XprvHex) => publicKey(xprvHex).pipe(Effect.flatMap(keyHash))
