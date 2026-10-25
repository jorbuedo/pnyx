/**
 * The shareable form of a circle invite.
 *
 * An invite **is** a 32-byte secret. A moderator publishes `inviteCommitment(secret)` on-chain with
 * `setInvite`, and whoever holds the secret redeems it by joining — the contract removes the
 * commitment, so it is single-use by absence rather than by a nullifier set that grows for ever.
 *
 * Bech32m, mirroring `pnyx_id` (`./identity`), for the same three reasons: it is checksummed, so a
 * mistyped code fails loudly instead of silently deriving a commitment that matches no invite; it is
 * case-insensitive and unambiguous when read aloud or retyped; and it is a natural QR payload, which
 * is how an invite is meant to travel.
 *
 * ⚠️ **The secret is the capability.** Anyone holding it can consume that invite, so it is shared
 * exactly like a one-time link and never logged. It carries no circle id: the invite is only ever
 * meaningful against the circle whose `invites` set holds its commitment, and binding one in would
 * make the code longer without making it safer.
 *
 * @module
 */

import {bech32m} from '@scure/base'

/** Distinct from `pnyx_id`'s HRP, so an identity pasted into an invite field is refused, not decoded. */
const HRP_PREFIX = 'pnyx_invite'

/** Encode an invite secret for sharing. The inverse of {@link decodeCircleInvite}. */
export const encodeCircleInvite = (secret: Uint8Array): string => {
  if (secret.length !== 32) {
    throw new Error(`pnyx_invite: secret must be 32 bytes, got ${secret.length}`)
  }
  return bech32m.encode(HRP_PREFIX, bech32m.toWords(secret), false)
}

/**
 * Decode a shared invite.
 *
 * Throws on a bad checksum, a foreign HRP or a wrong-length payload. A malformed code must not reach
 * the join builder: it would hash to a commitment no circle holds, and the join would fail as "no
 * such invite" — telling the user their invite was refused when in fact they mistyped it.
 */
export const decodeCircleInvite = (value: string): Uint8Array => {
  const {prefix, words} = bech32m.decode(value.trim() as `${string}1${string}`, false)
  if (prefix !== HRP_PREFIX) {
    throw new Error(`pnyx_invite: unexpected HRP '${prefix}'`)
  }
  const secret = bech32m.fromWords(words)
  if (secret.length !== 32) {
    throw new Error(`pnyx_invite: payload must be 32 bytes, got ${secret.length}`)
  }
  return Uint8Array.from(secret)
}

// ⚠️ There is deliberately no `isCircleInvite` here. It would be a `try`/`catch` that swallows, which
// this repo bans outright (CLAUDE.md), and this package has no logger to satisfy the rule with —
// adding one so a string-validation helper could log a typo would be the wrong dependency. The caller
// decodes and logs its own failure; the app does exactly that, at `debug`, because a half-typed code
// is an expected absence rather than a fault.
