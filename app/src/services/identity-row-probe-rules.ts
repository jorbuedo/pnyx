/**
 * Pure decision rules behind the identity-row probe (`app/settings/dev/identity-row-probe.tsx`).
 *
 * Separated from the screen because the interesting rule is not the rendering: it is *which network
 * can be read at all*, and the difference between "not deployed there" and "we could not find out".
 * Conflating those is the failure this exists to prevent — reporting an unreachable service as
 * "Pnyx is not on mainnet" would be a confident claim built on no information.
 *
 * @module
 */

/**
 * What a probe run against `selectedNetwork` can actually do.
 *
 * The address is **derived** from this identity's `C` rather than configured (one contract per
 * identity), so it no longer names a deployment — but the identity itself is network-scoped, so
 * exactly one network is readable and it is the one this build declares. `configuredNetwork` being
 * `null` still means we never found out, and must not be reported as "not deployed there".
 */
export type ProbeTarget =
  | {readonly kind: 'readable'; readonly address: string}
  /** The service never answered, so no network can be read and none can be ruled out either. */
  | {readonly kind: 'unknown'}
  /** The service answered, and it serves a different chain than the one asked about. */
  | {readonly kind: 'other-network'; readonly configuredNetwork: string}

/**
 * Resolve the probe target.
 *
 * `unknown` takes precedence over `other-network`: with no known network the answer is a guess, and
 * "Pnyx is deployed on X" must never be asserted from a failed read. A missing address alongside a
 * *known* network is still `unknown` rather than `other-network` — the derivation failed, which says
 * nothing about this network.
 */
export const probeTarget = (
  selectedNetwork: string,
  configuredNetwork: string | null,
  address: string | null,
): ProbeTarget => {
  if (configuredNetwork === null) return {kind: 'unknown'}
  if (configuredNetwork !== selectedNetwork) return {kind: 'other-network', configuredNetwork}
  if (address === null || address === '') return {kind: 'unknown'}
  return {kind: 'readable', address}
}

/**
 * Whether a row makes no `.night` claim.
 *
 * The field is a fixed 32 bytes, all zero when unclaimed — not an empty string and not absent, so a
 * truthiness check on it reports every unclaimed row as claimed.
 */
export const isUnclaimedName = (name: Uint8Array): boolean => name.every((byte) => byte === 0)

/**
 * How the cached registration flag stands against what the chain says.
 *
 * `stale` is the one that explains a mystery: sign-in skips the chain read when the flag is set, so a
 * flag with no row behind it produces a refused login that reads as a service fault. The other
 * disagreement (`uncached`) is benign — the next successful login records it.
 */
export type CacheVerdict = 'agree' | 'stale' | 'uncached' | 'agree-absent'

export const cacheVerdict = (cached: boolean, rowExists: boolean): CacheVerdict => {
  if (cached && rowExists) return 'agree'
  if (cached && !rowExists) return 'stale'
  if (!cached && rowExists) return 'uncached'
  return 'agree-absent'
}
