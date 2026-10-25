/**
 * Which Midnight network this build puts Pnyx identities on.
 *
 * ⚠️ **This is no longer an identity input.** An `pnyx_id` used to be network-scoped, so deriving
 * one meant knowing the network first — which is why the avatar picker needed a value it could read
 * without a fetch. `C` is now the same on every network, so nothing here feeds a derivation and the
 * avatar picker does not import this module at all.
 *
 * What the value still decides is *where things are looked up*: which chain holds the identity row
 * and its contracts, and what the login challenge commits to. `GET /auth/config` is the authority at
 * sign-in; a build declares its own (`EXPO_PUBLIC_PNYX_NETWORK`, a sibling of
 * `EXPO_PUBLIC_SERVICE_URL`) so a mismatch is caught rather than discovered as an empty lookup.
 *
 * Declaring it does not make it trusted — {@link identityNetworkDisagreement} is checked against
 * `/auth/config` at sign-in, so a wrong declaration fails loudly instead of quietly reading a chain
 * the service does not serve.
 *
 * @module
 */

import {pnyxNetwork} from '../config/env'

/**
 * The network this build declares. **Always declared** — `EXPO_PUBLIC_PNYX_NETWORK` is required, so
 * this throws rather than returning `null`.
 *
 * It used to be nullable, and the `null` branch meant "ask the content service instead". That is what
 * made a misconfigured service URL surface as an onboarding screen hanging on a TCP timeout while
 * doing work that is ~1 ms of local hashing. There is now one source for this value and no discovery
 * path: `scripts/env-check.ts` refuses to build without it.
 */
export const declaredIdentityNetwork = (): string => pnyxNetwork()

/**
 * Why the build's declared network and the service's reported one cannot both be right, or
 * `undefined` when there is nothing to reconcile (no declaration, or they agree).
 *
 * A mismatch is a build/deploy configuration fault, not a connectivity one, and must not be
 * reported as "unreachable" — the service answered perfectly well, it just isn't the network this
 * build derives identities for.
 */
export const identityNetworkDisagreement = (declared: string, reported: string): string | undefined =>
  declared !== reported
    ? `this build derives identities on '${declared}' but the service reports '${reported}'`
    : undefined
