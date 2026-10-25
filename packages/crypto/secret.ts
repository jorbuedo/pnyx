/**
 * Branded types for secret material, plus the one wipe helper that is actually
 * possible on Hermes.
 *
 * The point of branding is **enforceability, not concealment**. A brand makes
 * every place that holds seed-derived material greppable, type-checkable and
 * boundary-checkable, which is what lets the key-broker rule ("callers get
 * derived results, never key material") be checked by a machine instead of by a
 * reviewer. Phase 16 items 42–43 in `docs/mobile-shell-plan.md`.
 *
 * Two deliberate non-goals, both recorded because the obvious instinct is wrong:
 *
 * - **`Mnemonic` is a branded `string`, not bytes.** A BIP-39 mnemonic *is* a
 *   phrase; holding the UTF-8 bytes of its words protects nothing and only makes
 *   it awkward to pass to derivation. Hermes strings cannot be wiped either way,
 *   so bytes would buy a property this type never had.
 * - **A brand is not a boundary.** Nothing stops a caller casting into one. It
 *   raises the cost of doing so accidentally and makes the deliberate cases
 *   visible in review — which is the whole claim, and no more than that.
 *
 * @module
 */

declare const secretBrand: unique symbol

/**
 * A BIP-39 mnemonic phrase. Brand-only: identical to `string` at runtime.
 *
 * Mint with {@link asMnemonic} at the single point where the vault decrypts, so
 * every downstream holder is visible to a type check.
 */
export type Mnemonic = string & {readonly [secretBrand]: 'mnemonic'}

/**
 * Seed-derived key material held as **bytes** — a raw seed, a role key.
 * Brand-only: identical to `Uint8Array` at runtime.
 *
 * Distinct from {@link Mnemonic} because these *can* be wiped (see
 * {@link wipeSecret}) and because the two are never interchangeable at a call
 * site: one is an input to derivation, the other is its output.
 *
 * **Does not cover Cardano xprvs.** Those are strings in this codebase, because
 * the Cardano `Keys` tier is string-based end to end — use
 * {@link SecretText} for them. An earlier version of this doc claimed "an
 * extended private key", which was coverage this brand cannot provide.
 */
export type SecretBytes = Uint8Array & {readonly [secretBrand]: 'secret-bytes'}

/**
 * Seed-derived key material held as **text** — a bech32/hex extended private key.
 * Brand-only: identical to `string` at runtime.
 *
 * Exists because the thing that actually produces signatures in this codebase is a
 * *string* xprv (`ResolvedCredential.rootXprvHex`, the CIP-1852 role keys), and
 * neither existing brand fits: it is not a phrase, and it is not bytes. Without
 * this, the material closest to a signature was the only key material with no
 * brand at all.
 *
 * Like {@link Mnemonic}, and for the same Hermes reason, there is no wipe: strings
 * are immutable. Residency for these is bounded by eviction (dropping the
 * reference), not erasure — see `identity-role-keys.ts`.
 */
export type SecretText = string & {readonly [secretBrand]: 'secret-text'}

/**
 * Brand a decrypted mnemonic. Call this **only** where the plaintext first
 * enters the process (the credential vault); anywhere else it is laundering an
 * unbranded value past the type check.
 */
export const asMnemonic = (value: string): Mnemonic => value as Mnemonic

/**
 * Brand derived key material. Same rule as {@link asMnemonic}: call it at the
 * derivation that produced the bytes, not at a consumer that received them.
 */
export const asSecretBytes = (value: Uint8Array): SecretBytes => value as SecretBytes

/**
 * Brand a string-encoded derived key. Call it at the derivation that produced it —
 * which for these is always a derivation *from* already-branded material, so the
 * provenance chain is: vault → {@link Mnemonic} → root xprv → role key.
 */
export const asSecretText = (value: string): SecretText => value as SecretText

/**
 * Best-effort wipe of derived key material.
 *
 * Overwrites in place, which is all a JS realm allows: the GC may already have
 * copied the buffer during compaction, and a `Uint8Array` over a shared
 * `ArrayBuffer` wipes only its own view. So this bounds the window in which a
 * dump or a serialization can see the bytes — it does not guarantee erasure, and
 * no caller may treat it as though it does.
 *
 * There is no `Mnemonic` counterpart on purpose: Hermes strings are immutable.
 */
export const wipeSecret = (secret: SecretBytes): void => {
  secret.fill(0)
}
