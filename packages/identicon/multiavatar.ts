/**
 * Multiavatar — the avatar for an **Pnyx identity** (`pnyx_id`), not for a funds wallet.
 *
 * Blockies stays on Cardano/EVM wallet addresses on purpose: other wallets render the same blockie
 * for the same address, and that cross-app recognisability is worth more there than prettier art.
 * An `pnyx_id` is ours alone, so nothing is lost by using a nicer projection of it.
 *
 * ⚠️ **Recognition, never verification.** Multiavatar has 12,230,590,464 combinations ≈ 2^33.5, so
 * an attacker who wants an avatar that looks like yours simply grinds candidate keys until one
 * matches — minutes of work, not a lifetime. That is fine for "which row is my conversation with
 * Bob" and unsafe for "this is Bob". Any surface where a user *commits* to a peer must show the
 * `pnyx_id` and treat that as the identity.
 *
 * Wrapped rather than imported directly at call sites so the upstream module — which ships no
 * types, bundles its own SHA-256 and is CJS — is adapted in exactly one place.
 *
 * @module
 */

import multiavatar from '@multiavatar/multiavatar'

export type MultiavatarOptions = {
  /** Drop the circular background, for callers that supply their own frame. */
  readonly withoutBackground?: boolean
}

export type MultiavatarResult = {
  /** SVG markup. Uses only `<path>` + inline `style`, both of which react-native-svg parses. */
  asSvg(): string
}

/**
 * The avatar for `seed`.
 *
 * `seed` must be the **public** identity (`pnyx_id`) — never a secret and never a value only its
 * owner can compute, or peers would render a different avatar than the one you see for yourself.
 */
export const Multiavatar = (params: {seed: string} & MultiavatarOptions): MultiavatarResult => ({
  asSvg: () => multiavatar(params.seed, params.withoutBackground === true),
})
