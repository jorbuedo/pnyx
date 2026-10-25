/**
 * Where circuit artifacts are fetched from, and the URLs for each piece.
 *
 * Pure so it can be tested without expo-file-system or a network — the fetch/cache half lives in
 * `../pnyx-artifacts.ts`.
 *
 * **One origin, declared by the build.** Artifacts are static per compiled contract: the manifest is
 * a listing of compiled files with their hashes. So they belong on R2 served directly (free egress, no
 * Worker invocation, nothing on the sponsor host) — `docs/cloudflare-migration-plan.md`.
 * `EXPO_PUBLIC_ARTIFACTS_URL` is required; a build serving them from a local content service points it
 * at `http://<host>:3300/chain/artifacts`, which serves this exact layout. It did not, until
 * 2026-08-12: the service answered a REST shape (`/chain/artifacts/<target>/<circuit>/<kind>`) that
 * no prefix could make line up with the paths below, so the documented local configuration could
 * never have worked.
 *
 * **The layout keys circuit files by contract TARGET** (`identity/manifest.json`,
 * `circle/manifest.json`), and the manifest carries a `codeDigest` over the verifier keys so a client
 * can tell one compile from another. It used to key by deployed contract address, which broke twice
 * over once each circle became its own contract: the device would re-download an identical 53 MB key
 * set per circle, and a circle's keys are needed *before* its contract exists, so there is no address
 * to key them by. The SRS is contract-independent and shared.
 *
 * @module
 */

import {artifactsUrl} from '../../config/env'

/** The configured artifacts origin. Required, so this throws rather than returning `null`. */
export const artifactsOrigin = (): string => artifactsUrl()

/**
 * The KZG SRS for one circuit size.
 *
 * Its own function rather than `artifactSource(<any target>).params(k)`: the SRS is
 * contract-independent, and reaching it through a target would make a caller name one that has nothing
 * to do with the request — which is how the connector's proving provider, whose circuits belong to a
 * dApp rather than to any contract of ours, would have had to ask.
 */
export const srsUrl = (k: string): string => `${artifactsOrigin()}/params/bls_midnight_2p${k}`

export type ArtifactSource = {
  /** Where the manifest listing this contract's circuits lives. */
  readonly manifest: string
  /** One circuit file (`bzkir` / `prover` / `verifier`). */
  readonly circuit: (circuit: string, kind: string) => string
  /** The KZG SRS for a given K — contract-independent, so shared across deployments. */
  readonly params: (k: string) => string
}

/**
 * URLs for one compiled contract's artifacts. `target` is `identity` or `circle`.
 *
 * There used to be a second shape here: with no origin configured this fell back to the content
 * service's `/chain/*` routes. That was correct for local dev against a local chain and wrong
 * everywhere else — against the hosted Worker those routes 503, and the failure arrived as "identity
 * has not been registered" several layers away. `EXPO_PUBLIC_ARTIFACTS_URL` is now required, so a
 * build against a local service points it at that service explicitly and there is one code path.
 *
 * Dropping the fallback also dropped the `serviceUrl` parameter, which existed only to build it, and
 * the `kind` discriminator, which existed only to name which of the two had failed — the error
 * message carries the URL, which says more.
 */
export const artifactSource = (target: string): ArtifactSource => {
  const origin = artifactsOrigin()
  return {
    manifest: `${origin}/${target}/manifest.json`,
    circuit: (circuit, kind) => `${origin}/${target}/${circuit}.${kind}`,
    params: (k) => `${origin}/params/bls_midnight_2p${k}`,
  }
}

/**
 * Why a manifest cannot be used for `expected`, or `undefined` when it can.
 *
 * A manifest for the other contract lists prover keys that will not verify against the circuits being
 * proved. The node rejects the result, so this is not a soundness hole — but it is a bewildering
 * failure, and one a stale bucket makes reachable. Checked rather than assumed.
 */
export const manifestMismatch = (manifestTarget: string, expected: string): string | undefined =>
  manifestTarget === expected
    ? undefined
    : `artifact manifest is for the "${manifestTarget}" contract, but this build asked for "${expected}"`
