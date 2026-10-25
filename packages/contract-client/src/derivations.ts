// Client-side mirrors of `contract/identity.compact`'s domain-separated derivations.
//
// A client computes `C` off-chain to address its own row, so this must agree byte-for-byte with the
// circuit and with `preimage.rs`. `circle.compact`'s derivations live in `circle-derivations.ts` —
// separate because the shapes differ and two of the names collide.
//
// `pad32`, `fieldToBytes32` and `persistentHash32` are shared by both and stay here.
//
// **No `@midnight-ntwrk/compact-runtime` import**, and that is load-bearing rather than tidy: it
// drags in `@midnight-ntwrk/onchain-runtime-v3`, a WASM package with no resolvable `main`. Metro
// cannot bundle it and Hermes could not run it — so importing it anywhere the app reaches makes the
// Android app fail to build, with the error arriving as a bundler resolution failure several layers
// from the cause. `identity.ts` and `persona.ts` already said so; this module now matches them.
import {sha256} from '@noble/hashes/sha2.js'

/**
 * Compact's `persistentHash` over a `Vector<n, Bytes<32>>`: SHA-256 of the chunks concatenated.
 *
 * The equivalence is not assumed — every derivation below is pinned against a value the **compiled
 * circuit itself** emitted, and `preimage.rs` computes the same way over the same inputs. Three
 * independent implementations agreeing on the vectors is what licenses dropping the runtime.
 */
export const persistentHash32 = (chunks: readonly Uint8Array[]): Uint8Array => {
  const buf = new Uint8Array(chunks.length * 32)
  chunks.forEach((chunk, i) => {
    if (chunk.length !== 32) {
      throw new Error(`persistentHash32: chunk ${i} must be 32 bytes, got ${chunk.length}`)
    }
    buf.set(chunk, i * 32)
  })
  return sha256(buf)
}

/** Compact `pad(32, s)`: UTF-8 bytes of `s`, right-padded with zeros to 32 bytes. */
export const pad32 = (label: string): Uint8Array => {
  const encoded = new TextEncoder().encode(label)
  if (encoded.length > 32) {
    throw new Error(`pad32: label longer than 32 bytes: ${label}`)
  }
  const out = new Uint8Array(32)
  out.set(encoded)
  return out
}

/**
 * Compact `x as Bytes<32>` on a Field value — the field element little-endian, zero-padded.
 *
 * Matches `convertFieldToBytes(32, x)` and Rust's `Fr::as_le_bytes`; pinned by `actionNullifier`'s
 * vector, which is the only derivation that uses it.
 */
export const fieldToBytes32 = (x: bigint): Uint8Array => {
  if (x < 0n) {
    throw new Error('fieldToBytes32: field elements are non-negative')
  }
  const out = new Uint8Array(32)
  let rest = x
  for (let i = 0; i < 32 && rest > 0n; i++) {
    out[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  if (rest > 0n) {
    throw new Error('fieldToBytes32: value does not fit in 32 bytes')
  }
  return out
}

/**
 * `C` — the public Pnyx identity (`docs/PNYX_IDENTITY_PLAN.md`).
 *
 * Domain-separated so the account secret cannot collide with `personaCommitment`
 * (`circle-derivations.ts`) or any other derivation from the same seed. This is the *only* identifier a peer needs: the contract keys its
 * row by this value and authenticates writes by proving knowledge of `identitySk`, so there is no
 * signature to verify and nothing a reader has to check.
 */
export const identityCommitment = (identitySk: Uint8Array): Uint8Array =>
  persistentHash32([pad32('pnyx:id'), identitySk])

/**
 * The deploy nonce for `identity(C)`, so a peer holding `C` derives that contract's address without
 * a directory to consult (`docs/BOUNDED_STATE_ARCHITECTURE.md` §3.1).
 *
 * ⚠️ **The nonce is only half the address.** `address = SHA-256(tagged_serialize(ContractDeploy
 * {initial_state, nonce}))`, and the JS/WASM ledger's `ContractDeploy` samples its own nonce and
 * ignores one passed in — verified directly: two deploys of one identical state land on two
 * addresses. So the full derivation needs the native Rust rail, exactly as a circle's does
 * (`circle-derivations.ts`). This function is the part that is ours; the serialization is not.
 */
export const identityDeployNonce = (identity: Uint8Array): Uint8Array => {
  if (identity.length !== 32) {
    throw new Error(`identityDeployNonce: C must be 32 bytes, got ${identity.length}`)
  }
  return persistentHash32([pad32('pnyx:identity'), identity])
}

/**
 * The deploy nonce for `handle(name)`, so a client holding a name derives that contract's address
 * without a registry to consult (`docs/BOUNDED_STATE_ARCHITECTURE.md` §3.2).
 *
 * ⚠️ **`canonicalName` must be the folded spelling** — `encodeHandle` from
 * `@pnyx/contract-client/handle`, never `encodeDisplayName`. The address is what makes `Alice` and
 * `alice` one name, so deriving from a display spelling produces a second address for the same name
 * and strands it. That is the whole reason case folding is a client rule with exactly one entry point.
 *
 * ⚠️ **The nonce is only half the address**, as with `identityDeployNonce`: the full derivation is
 * `SHA-256(tagged_serialize(ContractDeploy {initial_state, nonce}))`, and the JS ledger's
 * `ContractDeploy` samples its own nonce and ignores one passed in. The serialization needs the native
 * Rust rail.
 */
export const handleDeployNonce = (canonicalName: Uint8Array): Uint8Array => {
  if (canonicalName.length !== 32) {
    throw new Error(`handleDeployNonce: a handle must be 32 bytes, got ${canonicalName.length}`)
  }
  return persistentHash32([pad32('pnyx:handle'), canonicalName])
}

/**
 * The domain separator for a tier's claim-permit color — `tokenType(domain, paymentContract)`.
 *
 * Must match `bind`'s own selection exactly: it accepts a permit of **exactly** the name's tier, so a
 * caller that buys the wrong tier's color builds a transaction that cannot prove.
 */
export const permitDomain = (tier: number): Uint8Array => {
  if (!Number.isInteger(tier) || tier < 0 || tier > 6) {
    throw new Error(`permitDomain: tier must be an integer 0..6, got ${tier}`)
  }
  return pad32(`pnyx:permit:t${tier}`)
}

/**
 * The domain separator for a name's **rebind** permit — per name, granted by us, never purchasable.
 *
 * Per name rather than per tier because pricing a transfer per name would need a `prices` map keyed by
 * name, which is the growing structure the per-item design exists to remove.
 */
export const rebindPermitDomain = (canonicalName: Uint8Array): Uint8Array => {
  if (canonicalName.length !== 32) {
    throw new Error(`rebindPermitDomain: a handle must be 32 bytes, got ${canonicalName.length}`)
  }
  return persistentHash32([pad32('pnyx:rebind'), canonicalName])
}

/**
 * The domain separator for a name's **moderation** capability — `tokenType(domain, paymentContract)`.
 *
 * This is `handle.compact`'s sealed `moderateDomain`, derived in its constructor from the same name, so
 * it is part of the handle's address; and it is the colour `payment.grantModeratePermit` mints. Holding
 * that token is what authorises `moderate` — the handle template carries no admin secret of its own.
 *
 * Per name rather than one colour for the namespace, so a stolen token silences one name. And minted by
 * `payment` rather than gated by a per-handle secret, because rotating a per-handle secret would cost
 * one transaction per name: this way the whole namespace rotates with `payment.rotateAdmin` alone.
 */
export const moderatePermitDomain = (canonicalName: Uint8Array): Uint8Array => {
  if (canonicalName.length !== 32) {
    throw new Error(`moderatePermitDomain: a handle must be 32 bytes, got ${canonicalName.length}`)
  }
  return persistentHash32([pad32('pnyx:moderate'), canonicalName])
}

/**
 * `payment.compact`'s `priceKey(tier, color)` — what the `prices` map is keyed by.
 *
 * Domain-separated so a currency's own colour can never collide with a tier's permit domain, which
 * would let a colour name a price row it does not own.
 *
 * ⚠️ Must agree with the circuit byte for byte: a client that derives a different key reads a price
 * row that does not exist and reports "currency not accepted" for one that is.
 */
/**
 * The colour a **free** tier's row is written under — `payment.compact`'s `freeColor()`.
 *
 * Free is modelled as a currency so the free list is just a `prices` row: `setPrice(tier, freeColor, 1)`
 * opens a tier and a price of 0 closes it, with no second admin circuit. ⚠️ The row's amount is never
 * read; only its presence is. It cannot collide with a real currency, because a currency colour is a
 * token type and this is a domain hash nobody can mint under.
 */
export const FREE_COLOR: Uint8Array = pad32('pnyx:free')

export const permitPriceKey = (tier: number, color: Uint8Array): Uint8Array => {
  if (color.length !== 32) {
    throw new Error(`permitPriceKey: a colour is 32 bytes, got ${color.length}`)
  }
  return persistentHash32([pad32('pnyx:price'), permitDomain(tier), color])
}

/**
 * The ledger's own token-colour derivation, reproduced in JS.
 *
 *     tokenType = SHA-256( pad32("midnight:derive_token") ‖ domain ‖ contractAddress )
 *
 * This is `ContractAddress::custom_unshielded_token_type` from `midnight-coin-structure`, which is
 * `persistent_commit(&(domain, address), "midnight:derive_token")` — and `persistent_commit` is
 * `SHA-256(opening ‖ value)` with `HashOutput`'s binary representation being its raw 32 bytes. So it
 * needs no ledger serialization and no native call, unlike a contract *address*, whose nonce is only
 * half the input ({@link identityDeployNonce}).
 *
 * Reproduced rather than bridged because a caller only wants to *recognise* a colour it already
 * knows the domain of — matching against a wallet's `totals` map — and that must work on Hermes
 * without a bridge hop. Pinned against the real function by `token_type_matches_the_ledger` in
 * `rust/tests/token_type.rs`; **change both** if either moves.
 */
export const customUnshieldedTokenType = (contractAddress: Uint8Array, domain: Uint8Array): Uint8Array => {
  if (contractAddress.length !== 32) {
    throw new Error(`customUnshieldedTokenType: a contract address is 32 bytes, got ${contractAddress.length}`)
  }
  if (domain.length !== 32) {
    throw new Error(`customUnshieldedTokenType: a domain is 32 bytes, got ${domain.length}`)
  }
  const input = new Uint8Array(96)
  input.set(pad32('midnight:derive_token'))
  input.set(domain, 32)
  input.set(contractAddress, 64)
  return sha256(input)
}

/**
 * The token colour a tier's claim permit is minted in — what a wallet's balance has to be matched
 * against to answer "do I hold a permit for this tier".
 *
 * ⚠️ Exact tier, never tier-or-better: `bind` accepts only the name's own tier, so holding a t0 permit
 * does not let you claim a t3 name.
 */
export const permitTokenType = (paymentAddress: Uint8Array, tier: number): Uint8Array =>
  customUnshieldedTokenType(paymentAddress, permitDomain(tier))
