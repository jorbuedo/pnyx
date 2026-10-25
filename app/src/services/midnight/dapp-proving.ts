/**
 * Proving a **dApp's** circuit on this device — the wallet side of the connector's `getProvingProvider`.
 *
 * The differentiator in one sentence: every other wallet's proving provider forwards to a proof server,
 * and ours is the phone. `@pnyx/midnight-native` already proves our own circuits; this feeds it circuits
 * that arrive with the request instead.
 *
 * ⚠️ **A dApp's keys are not artifacts of ours, and are deliberately not fetched like them.**
 * `ensureCircuitArtifacts` is manifest-driven because the manifest is the trust root for *our* compiled
 * contracts. A dApp is the authority on its own circuit: it hands over the ZKIR, prover key and
 * verifier key, and the only thing we can check is that they agree with each other — which proving does,
 * because a proof is verified against the verifier key before it is returned. So the bytes are cached
 * under a digest of what was actually supplied, never trusted by name.
 *
 * ⚠️ **The SRS is the one thing we do not take from the dApp.** It is the root of proof soundness, so it
 * comes from our own origin and is checked against the pinned ceremony catalog
 * ({@link ensureSrsForK}). A dApp supplying its own SRS could hand us one with a known trapdoor.
 *
 * @module
 */

import {sha256} from '@noble/hashes/sha2.js'
import {hex} from '@pnyx/crypto'
import {ApiErrorCode, type MidnightErrorCode, WireError} from '@pnyx/dapp-connector'
import {type CircuitArtifactPaths, checkPreimage, circuitK, provePreimageWithBinding} from '@pnyx/midnight-native'
import {Directory, File, Paths} from 'expo-file-system'
import {logger} from '../../logger'
import {cacheFilePath, ensureSrsForK} from '../pnyx-artifacts'
import {DEVICE_MAX_K, provingRouteFor} from './proving-route'

/**
 * A refusal the page can act on.
 *
 * Thrown as a `WireError` so `dapp-context`'s wrapper passes it through untouched instead of
 * flattening it — proving refusals are answers to the page, not internal faults, and the difference
 * between "your circuit is too big" and "this wallet is misconfigured" is the difference between a
 * dApp splitting its circuit and a dApp filing a bug.
 */
const refusal = (message: string, apiCode: MidnightErrorCode = 'InternalError'): WireError =>
  new WireError({
    code: apiCode === 'InvalidRequest' ? ApiErrorCode.InvalidRequest : ApiErrorCode.InternalError,
    message,
    apiCode,
  })

const ORIGIN = 'midnight-dapp-proving'

/**
 * The largest circuit this device will prove for a dApp.
 *
 * Re-exported from the routing rule, which owns it — the ceiling and the decision it feeds belong
 * together, and a second copy here is how the two drift.
 */
export const MAX_DAPP_CIRCUIT_K = DEVICE_MAX_K

/** The three files a circuit is, as the dApp's `KeyMaterialProvider` supplies them. */
export type DappCircuitMaterial = {
  readonly zkir: Uint8Array
  readonly proverKey: Uint8Array
  readonly verifierKey: Uint8Array
}

/** The digest a circuit is cached under: SHA-256 of `zkir ‖ proverKey ‖ verifierKey`, hex. */
export const circuitDigest = (material: DappCircuitMaterial): string =>
  hex.encode(sha256(new Uint8Array([...material.zkir, ...material.proverKey, ...material.verifierKey])))

const circuitDir = (digest: string): Directory => new Directory(Paths.cache, 'pnyx-dapp-circuits', digest)

const pathsIn = (dir: Directory, paramsPath: string): CircuitArtifactPaths => ({
  zkirPath: cacheFilePath(new File(dir, 'circuit.bzkir')),
  proverKeyPath: cacheFilePath(new File(dir, 'circuit.prover')),
  verifierKeyPath: cacheFilePath(new File(dir, 'circuit.verifier')),
  paramsPath,
})

/**
 * The paths for a circuit already cached under `digest`, or `null`.
 *
 * What makes the digest handshake safe rather than merely fast: the cache is content-addressed and
 * every write verifies the bytes against the digest claimed for them ({@link cacheDappCircuit}), so a
 * page cannot poison an entry another page will later ask for by name.
 */
export const cachedDappCircuit = async (digest: string): Promise<CircuitArtifactPaths | null> => {
  const dir = circuitDir(digest)
  const zkir = new File(dir, 'circuit.bzkir')
  if (!dir.exists || !zkir.exists) return null
  const k = circuitK(await zkir.bytes())
  return pathsIn(dir, await ensureSrsForK(String(k)))
}

/**
 * Cache one dApp circuit and return the paths the native prover reads.
 *
 * Keyed by a digest of the **bytes**, not of the `keyLocation`: two dApps may use the same location
 * string for different circuits, and one dApp may recompile under an unchanged name. Keying by content
 * makes both cases correct and makes a re-supply of identical bytes free.
 */
export const cacheDappCircuit = async (
  material: DappCircuitMaterial,
  claimedDigest?: string,
): Promise<CircuitArtifactPaths> => {
  const digest = circuitDigest(material)
  if (claimedDigest !== undefined && claimedDigest !== digest) {
    // The caller named one circuit and sent another. Storing it would let a page put bytes into an
    // entry a *different* page asks for by digest, which is the one thing content addressing must not
    // allow.
    throw refusal('the circuit does not match the digest it was sent under', 'InvalidRequest')
  }
  const k = circuitK(material.zkir)
  // Routed rather than compared, so the proving mode becomes a setting without this call site changing.
  // `device` is hardcoded here because it is the only mode implemented; see `./proving-route`.
  const route = provingRouteFor(k, 'device')
  // The page sent a circuit larger than this device can prove. Well-formed, unfulfillable here — and
  // naming it as the request's shape is what lets a dApp split the circuit rather than retry blindly.
  if (route.route === 'refuse') throw refusal(route.reason, 'InvalidRequest')
  if (route.route === 'server') {
    // Unreachable while the mode above is fixed. Left as a refusal rather than a fall-through to
    // device: delegating is not something to do because a local path happened to exist.
    throw refusal('this wallet has no proof server to delegate to')
  }

  const dir = circuitDir(digest)
  if (!dir.exists) {
    dir.create({intermediates: true})
  }
  const write = (name: string, bytes: Uint8Array): File => {
    const file = new File(dir, name)
    // Content-addressed, so an existing file of the right size *is* the right file.
    if (!file.exists || file.size !== bytes.length) {
      if (file.exists) file.delete()
      file.create()
      file.write(bytes)
    }
    return file
  }

  write('circuit.bzkir', material.zkir)
  write('circuit.prover', material.proverKey)
  write('circuit.verifier', material.verifierKey)

  logger.debug('cached a dApp circuit for proving', {
    origin: ORIGIN,
    digest,
    k,
    zkirBytes: material.zkir.length,
    proverKeyBytes: material.proverKey.length,
  })
  return pathsIn(dir, await ensureSrsForK(String(k)))
}

/**
 * The `check` half: is this preimage well formed for this circuit?
 *
 * Needs the ZKIR alone — no keys, no SRS, nothing cached — so it stays a direct call rather than going
 * through {@link cacheDappCircuit}. That is also why a dApp can check a circuit this device would
 * refuse to prove.
 */
export const dappCheckPreimage = async (zkir: Uint8Array, preimage: Uint8Array): Promise<(number | undefined)[]> => {
  const skips = await checkPreimage(zkir, preimage)
  logger.debug('checked a dApp proof preimage', {origin: ORIGIN, entries: skips.length})
  return skips
}

/**
 * The `prove` half: the proof, produced and verified on this device.
 *
 * Seconds of CPU at K=14/15. Logged on success as well as failure — a proving rail that says nothing
 * when it works cannot be told from one that never ran, and this one is invisible to the user by
 * design.
 */
export const dappProve = async (params: {
  /** Names the circuit. The material may be omitted when this device already holds it. */
  readonly digest: string
  readonly zkir?: Uint8Array
  readonly proverKey?: Uint8Array
  readonly verifierKey?: Uint8Array
  readonly preimage: Uint8Array
  readonly bindingInput?: Uint8Array
}): Promise<Uint8Array> => {
  const {digest, zkir, proverKey, verifierKey, preimage, bindingInput} = params
  const cached = zkir === undefined ? await cachedDappCircuit(digest) : null
  // Said out loud because the difference is ~35 s of bridge: a page asking by digest and being told
  // "no" silently looks exactly like a page that never tried.
  logger.debug('a dApp prove request arrived', {
    origin: ORIGIN,
    digest,
    askedByDigest: zkir === undefined,
    cacheHit: cached !== null,
  })
  if (zkir === undefined && cached === null) {
    // Said plainly so the page knows to resend rather than to give up: on device the bytes cost ~38 s
    // of bridge for a 10 MB prover key, which is why it was allowed to try without them.
    throw refusal(`circuit ${digest} is not on this device — send the circuit with the request`, 'InvalidRequest')
  }
  const paths =
    cached ??
    (await cacheDappCircuit(
      {zkir: zkir as Uint8Array, proverKey: proverKey as Uint8Array, verifierKey: verifierKey as Uint8Array},
      digest,
    ))
  const started = Date.now()
  const proof = await provePreimageWithBinding(paths, preimage, bindingInput)
  logger.info('proved a dApp circuit on device', {
    origin: ORIGIN,
    ms: Date.now() - started,
    proofBytes: proof.length,
    boundInput: bindingInput !== undefined,
    // Which half the caller paid for: a cache hit skips the megabytes.
    circuitFromCache: cached !== null,
  })
  return proof
}
