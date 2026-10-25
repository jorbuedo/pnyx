/**
 * On-device circuit-artifact fetch + cache for the phase-B proving rail.
 *
 * The native prover needs each circuit's compile outputs (`.bzkir`/`.prover`/`.verifier`) plus the
 * KZG SRS for its K. This module fetches them from whichever origin the build is pointed at
 * (`pnyx-artifacts/origin.ts` — R2 when configured, the content service otherwise),
 * SHA-256-verifies every download against the manifest, and caches them so subsequent builds skip
 * the network. It returns the cached file *paths* — the native module reads the multi-MB artifacts
 * from disk (only the tx/preimage cross the JNI bridge).
 *
 * Cache layout (expo-file-system cache dir):
 *   pnyx-artifacts/<target>-<codeDigest>/<circuit>.{bzkir,prover,verifier}  — versioned by CODE
 *   pnyx-artifacts/params/bls_midnight_2p<K>                             — contract-independent SRS
 *
 * K is derived from the downloaded `.bzkir` via the native `circuitK` (no hardcoded K-per-circuit
 * table to drift on recompile), then names the SRS to fetch.
 */

import {sha256} from '@noble/hashes/sha2.js'
import {type CircuitArtifactPaths, circuitK} from '@pnyx/midnight-native'
import {Directory, File, Paths} from 'expo-file-system'
import {logger} from '../logger'
import {startOnce} from './pnyx-artifacts/once'
import {artifactSource, manifestMismatch, srsUrl} from './pnyx-artifacts/origin'
import {officialSrsForK} from './pnyx-srs-catalog'

const ORIGIN = 'pnyx-artifacts'

type ArtifactFile = {readonly size: number; readonly sha256: string}
type CircuitArtifacts = {readonly bzkir: ArtifactFile; readonly prover: ArtifactFile; readonly verifier: ArtifactFile}
type ArtifactManifest = {
  readonly target: string
  readonly codeDigest: string
  readonly circuits: Readonly<Record<string, CircuitArtifacts>>
  readonly params: Readonly<Record<string, ArtifactFile>>
}

const CIRCUIT_KINDS = ['bzkir', 'prover', 'verifier'] as const
type CircuitKind = (typeof CIRCUIT_KINDS)[number]

const toHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}
const sha256Hex = (bytes: Uint8Array): string => toHex(sha256(bytes))

/** Plain filesystem path for the native prover (Rust `std::fs`), not a `file://` URI. */
const nativePath = (file: File): string => file.uri.replace(/^file:\/\//, '')
/** Same `file://`-stripping for a directory — the native side takes plain paths. */
const nativeDirPath = (dir: Directory): string => dir.uri.replace(/^file:\/\//, '').replace(/\/$/, '')

/**
 * Files verified against a checksum during this process's lifetime, `uri` → the sha256 they matched.
 *
 * ⚠️ **This is a performance fix with teeth, so the reasoning matters.** Verifying a cached file means
 * reading it and hashing it in JS: a 6 MB SRS costs seconds on device, and the connector's proving
 * provider calls this on *every* proof. Measured: 11 s of a 16 s cache-hit proof was this hash, against
 * 4.5 s of actual proving.
 *
 * The guarantee is unchanged in the way that counts — every byte still gets verified before it can
 * reach the prover, once, and a fresh download is always verified. What is dropped is *re-*verifying a
 * file this same process already checked, and the app is the only writer of these directories.
 */
const verifiedThisSession = new Map<string, string>()

/**
 * Ensure `file` holds bytes matching `expected` (size + SHA-256), downloading from `url` if the
 * cached copy is absent or stale. Throws if a fresh download still fails verification (a corrupt or
 * wrong-deployment artifact must never reach the prover).
 */
const ensureVerifiedFile = async (file: File, url: string, expected: ArtifactFile): Promise<void> => {
  if (verifiedThisSession.get(file.uri) === expected.sha256 && file.exists && file.size === expected.size) {
    return
  }
  if (file.exists) {
    const cached = await file.bytes()
    if (cached.length === expected.size && sha256Hex(cached) === expected.sha256) {
      verifiedThisSession.set(file.uri, expected.sha256)
      return
    }
    file.delete()
  }
  await File.downloadFileAsync(url, file)
  const got = await file.bytes()
  if (sha256Hex(got) !== expected.sha256) {
    file.delete()
    throw new Error(`artifact ${url} failed SHA-256 verification (expected ${expected.sha256}, got ${sha256Hex(got)})`)
  }
  verifiedThisSession.set(file.uri, expected.sha256)
}

/**
 * Fetch + cache everything the native prover needs for `circuit`, returning the on-device paths for
 * `buildJoinOpenCircleProvenTx` / `proveCircuit`. Idempotent: cached, verified files are reused.
 */
/**
 * Which compiled contract a circuit belongs to.
 *
 * A union rather than `string` on purpose: this parameter used to be a contract **address**, and both
 * are strings — so every call site would have kept compiling while asking for artifacts at
 * `<64-hex>/manifest.json`, which 404s at runtime. The compiler catches it instead.
 */
/**
 * `zswap` is not one of our contracts: it names the ledger's own protocol circuits
 * (`midnight/zswap/{spend,output,sign}`), mirrored to our origin so a device can prove a shielded
 * spend without reaching upstream's data provider. Same manifest shape, same verification.
 */
export type ArtifactTarget = 'identity' | 'circle' | 'proposal' | 'payment' | 'handle' | 'zswap' | 'dust'

/**
 * How long the manifest fetch may take before this device falls back to the copy it already has.
 *
 * ⚠️ **The artifacts are cached and the manifest that gates them was not, so a warm cache could still
 * hang.** Every circuit file here is kept on disk and SHA-256-verified, which is what makes a second
 * proof fast and an offline one possible at all — but reaching them started with an unbounded `fetch`
 * of the manifest from a Cloudflare origin. A host that accepts the connection and never answers left
 * proving pending for ever with every byte it needed already on the device.
 */
const MANIFEST_TIMEOUT_MS = 15_000

/** Where the last manifest this device successfully read is kept, per target. */
const manifestCacheFile = (target: ArtifactTarget): File =>
  new File(new Directory(Paths.cache, 'pnyx-artifacts'), `manifest-${target}.json`)

/**
 * The manifest for `target`: from the origin when it answers, otherwise the last one this device saw.
 *
 * ⚠️ **A stale manifest is not a wrong one, and that is why the fallback is sound.** Every entry is
 * keyed by the contract's `codeDigest`, and the artifacts it names are cached under that digest — so an
 * old manifest resolves to the artifacts of the code it described, never a mixture. If that code is not
 * what is deployed, the proof or the submission fails the same way it would with no cache at all. What
 * the fallback removes is the third outcome, which was the only unrecoverable one: hanging.
 */
const readManifest = async (target: ArtifactTarget): Promise<ArtifactManifest> => {
  const running = manifestsInFlight.get(target)
  if (running !== undefined) return running
  const read = fetchManifest(target).finally(() => manifestsInFlight.delete(target))
  manifestsInFlight.set(target, read)
  return read
}

/**
 * Manifest reads in flight, so two consumers that want the same target at once share one fetch.
 *
 * ⚠️ **Not a cache, deliberately.** A sequential caller still re-reads, which is what keeps a
 * redeployed contract's manifest from being pinned for the life of the process. This only collapses
 * requests that genuinely overlap — which two handle-address derivations racing each other did, and
 * that is where the duplicate `handle/manifest.json` fetch came from.
 */
const manifestsInFlight = new Map<ArtifactTarget, Promise<ArtifactManifest>>()

/** One read: the origin when it answers, otherwise the last manifest this device kept. */
const fetchManifest = async (target: ArtifactTarget): Promise<ArtifactManifest> => {
  const source = artifactSource(target)
  const cached = manifestCacheFile(target)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS)
  try {
    const res = await fetch(source.manifest, {signal: controller.signal})
    if (!res.ok) {
      throw new Error(`artifact manifest fetch failed: ${res.status} ${source.manifest}`)
    }
    const body = await res.text()
    const manifest = JSON.parse(body) as ArtifactManifest
    const mismatch = manifestMismatch(manifest.target, target)
    if (mismatch !== undefined) {
      throw new Error(mismatch)
    }
    try {
      cached.parentDirectory.create({intermediates: true, idempotent: true})
      cached.write(body)
    } catch (error) {
      // Not fatal: the manifest we just read is good, we simply could not keep it for next time.
      logger.warn('the artifact manifest could not be cached for offline use', {
        origin: ORIGIN,
        target,
        error: String(error),
      })
    }
    return manifest
  } catch (error) {
    if (!cached.exists) throw error
    const manifest = JSON.parse(await cached.text()) as ArtifactManifest
    const mismatch = manifestMismatch(manifest.target, target)
    if (mismatch !== undefined) throw error
    // ⚠️ Loud, because proving against the last manifest this device saw is a different fact from
    // proving against the current one, and the difference only shows up as a failed submission.
    logger.warn('the artifact origin did not answer; using the last manifest this device saw', {
      origin: ORIGIN,
      target,
      codeDigest: manifest.codeDigest,
      error: String(error),
    })
    return manifest
  } finally {
    clearTimeout(timer)
  }
}

export const ensureCircuitArtifacts = async (
  circuit: string,
  target: ArtifactTarget,
): Promise<CircuitArtifactPaths> => {
  const source = artifactSource(target)
  // The manifest is the trust root for every circuit file below, so it has to be for the contract
  // being proved — `readManifest` checks that on both the fetched and the cached path.
  const manifest = await readManifest(target)
  const entry = manifest.circuits[circuit]
  if (!entry) {
    throw new Error(`manifest has no artifacts for circuit "${circuit}"`)
  }

  // Cached under the compiled code's digest, not a deployed address: the keys belong to the contract's
  // code, so every circle deployed from the same `circle.compact` shares one download (53 MB of prover
  // keys, once) and a recompile invalidates them by changing the digest.
  const dir = new Directory(Paths.cache, 'pnyx-artifacts', `${manifest.target}-${manifest.codeDigest}`)
  if (!dir.exists) {
    dir.create({intermediates: true})
  }
  const files = {} as Record<CircuitKind, File>
  for (const kind of CIRCUIT_KINDS) {
    const file = new File(dir, `${circuit}.${kind}`)
    await ensureVerifiedFile(file, source.circuit(circuit, kind), entry[kind])
    files[kind] = file
  }

  // K from the bzkir → the SRS to fetch. The SRS is contract-independent, so it lives in a shared
  // dir and is cached once across all circuits/deployments.
  const k = String(circuitK(await files.bzkir.bytes()))
  // Fail loudly if the manifest disagrees with the ceremony catalog — that means the service is
  // serving a non-official SRS. `ensureSrsForK` re-checks against the catalog either way; this checks
  // what the service *claims*, which is the part only a manifest-driven fetch can see.
  const paramsEntry = manifest.params[k]
  if (!paramsEntry) {
    throw new Error(`manifest has no SRS for K=${k} (circuit "${circuit}")`)
  }
  const official = officialSrsForK(k)
  if (paramsEntry.sha256 !== official.sha256 || paramsEntry.size !== official.size) {
    throw new Error(
      `advertised SRS for K=${k} disagrees with the official Midnight ceremony catalog ` +
        `(manifest ${paramsEntry.size}/${paramsEntry.sha256}, official ${official.size}/${official.sha256})`,
    )
  }

  return {
    zkirPath: nativePath(files.bzkir),
    proverKeyPath: nativePath(files.prover),
    verifierKeyPath: nativePath(files.verifier),
    paramsPath: await ensureSrsForK(k),
  }
}

/**
 * Fetch + cache the KZG SRS for one circuit size, returning its on-device path.
 *
 * Shared by the contract rail above and by the dApp connector's proving provider, which proves
 * circuits that are in no manifest of ours — so the *only* check available there is the pinned
 * ceremony catalog. That is also the check that matters: the SRS is the root of proof soundness, and a
 * compromised service must not be able to substitute one even if its own manifest agrees with the
 * bytes it serves.
 *
 * Contract-independent by nature, so one shared directory and one download per K for the whole app.
 */
export const ensureSrsForK = async (k: string): Promise<string> => {
  const official = officialSrsForK(k)
  const paramsDir = new Directory(Paths.cache, 'pnyx-artifacts', 'params')
  if (!paramsDir.exists) {
    paramsDir.create({intermediates: true})
  }
  const srs = new File(paramsDir, `bls_midnight_2p${k}`)
  await ensureVerifiedFile(srs, srsUrl(k), official)
  return nativePath(srs)
}

/** A cached file's path in the form the native side reads (no `file://` scheme). */
export const cacheFilePath = (file: File): string => nativePath(file)

/**
 * Fetch + cache **every** verifier key of one contract, returning the directory holding them.
 *
 * This is what a deploy needs, and it is the one artifact call that is not per-circuit: the deploy's
 * `operations` map carries one verifier key per entry point, and all of it feeds the contract's
 * address — so a missing or extra key is a different address, not a slower path. Prover keys are not
 * fetched: a constructor is not a circuit, so nothing here is proved.
 *
 * Also what an *address derivation* needs, which is why it is no longer circle-only: with one contract
 * per identity and one per handle, deriving where a contract lives means hashing the same keys the
 * deploy would carry.
 *
 * The directory is the same code-digest-keyed one `ensureCircuitArtifacts` uses, and the files are
 * named `<circuit>.verifier`, which is the layout the native side reads.
 */
export const ensureVerifierKeys = async (target: ArtifactTarget): Promise<string> => {
  const source = artifactSource(target)
  const manifest = await readManifest(target)
  const dir = new Directory(Paths.cache, 'pnyx-artifacts', `${manifest.target}-${manifest.codeDigest}`)
  if (!dir.exists) {
    dir.create({intermediates: true})
  }
  // Every circuit in the manifest, not a hardcoded list: a missing or extra entry point is a
  // different contract with a different address, so the manifest is the authority on the set.
  for (const [circuit, entry] of Object.entries(manifest.circuits)) {
    await ensureVerifiedFile(new File(dir, `${circuit}.verifier`), source.circuit(circuit, 'verifier'), entry.verifier)
  }
  return nativeDirPath(dir)
}

/** The circle template's verifier keys — what a circle deploy and a circle address derivation read. */
export const ensureCircleVerifierKeys = (): Promise<string> => ensureVerifierKeys('circle')

/**
 * Every `proposal.compact` verifier key, for deriving a proposal's address and building its deploy.
 *
 * Separate from the circle's for the same reason the contracts are separate: a proposal is its own
 * deploy, and its address commits to *its* two entry points. Fetching the circle's set here would
 * derive an address no proposal is ever at.
 */
export const ensureProposalVerifierKeys = (): Promise<string> => ensureVerifierKeys('proposal')

/**
 * The circuit a DUST fee payment proves, and the directories the native prover reads for it.
 *
 * Paying a Midnight fee is not free of proving: `DustLocalState::spend` yields a
 * `DustSpend<ProofPreimageMarker>` and `Transaction::prove` walks `dust_actions`. The circuit is
 * `midnight/dust/spend` at **K=13** — ~2.2 MB of prover key against an SRS the forum circuits already
 * fetch, so cheap next to the 9.6 MB K=15 keys.
 *
 * ⚠️ **Its own target, not a fourth entry beside the zswap circuits.** Both families name their circuit
 * `spend`, and `ensureCircuitArtifacts` caches under `<target>-<codeDigest>` with files named
 * `<circuit>.<kind>` — so sharing a directory would have `dust/spend.prover` overwrite
 * `zswap/spend.prover`. Separate targets keep them apart, and the native `DirResolver` gets one
 * directory per family.
 *
 * The prover key was **generated rather than obtained**: the ledger crate ships this circuit's zkir,
 * bzkir and verifier but only a hash for the prover key, and a prover key is a preprocessing of the
 * circuit against the SRS. `rust/tests/dust_spend_prover_key.rs` regenerates it and asserts it matches
 * upstream's pinned hash, so its provenance is reproducible rather than trusted.
 */
export const ensureDustArtifacts = async (): Promise<{artifactDir: string; paramsDir: string}> => {
  const paths = await ensureCircuitArtifacts('spend', 'dust')
  return {
    artifactDir: paths.zkirPath.slice(0, paths.zkirPath.lastIndexOf('/')),
    paramsDir: paths.paramsPath.slice(0, paths.paramsPath.lastIndexOf('/')),
  }
}

/** The three protocol circuits a shielded spend proves. Their `KeyLocation`s are the ledger's. */
const ZSWAP_CIRCUITS = ['spend', 'output', 'sign'] as const

/**
 * Fetch + cache the protocol circuits a shielded transfer needs, returning the two directories the
 * native builder reads.
 *
 * ~19 MB of prover keys, once per ledger major — the manifest's `codeDigest` is that major, so a
 * protocol bump re-downloads and anything else does not. Sequential rather than parallel: this is a
 * phone on someone's data plan, and three concurrent multi-MB downloads buy nothing here.
 *
 * The directories are what the native side wants, not the files: `DirResolver` reads
 * `<circuit>.<kind>` out of one and `bls_midnight_2p<K>` out of the other, which is exactly the layout
 * {@link ensureCircuitArtifacts} caches into.
 */
export const ensureZswapArtifacts = async (): Promise<{artifactDir: string; paramsDir: string}> => {
  let artifactDir: string | undefined
  let paramsDir: string | undefined
  for (const circuit of ZSWAP_CIRCUITS) {
    const paths = await ensureCircuitArtifacts(circuit, 'zswap')
    // Derived from what was actually fetched rather than rebuilt from the cache layout, so the two can
    // never disagree about where the files went.
    artifactDir = paths.zkirPath.slice(0, paths.zkirPath.lastIndexOf('/'))
    paramsDir = paths.paramsPath.slice(0, paths.paramsPath.lastIndexOf('/'))
  }
  if (artifactDir === undefined || paramsDir === undefined) {
    throw new Error('no zswap circuits were fetched')
  }
  return {artifactDir, paramsDir}
}

/**
 * Warm the identity circuit's artifacts in the background, once per process.
 *
 * **Why only identity.** Every `ensure*` above is lazy — called at the point of use, with nothing
 * prefetching — so the first identity publish blocks inline on a ~14 MB download. Registering is
 * the first Midnight thing a new account does, so that stall lands squarely in onboarding. The
 * other contracts are deliberately left lazy: `payment` alone is 54 MB and `circle` 29 MB, and a
 * user who never opens a circle should never pay for its keys.
 *
 * ⚠️ **This is not an offline story and cannot become one.** A proof is only useful once it is
 * submitted, and signing in needs the content service — so nothing here lets the app work without
 * a network. It moves a multi-MB download out of the user's way, nothing more.
 *
 * Fire-and-forget by design: the caller must not wait on it, and a failure is not an error for
 * anyone — the lazy path still runs later and downloads exactly the same files. Logged either way,
 * because a warm-up that silently never ran is indistinguishable from one that worked.
 */
export const prefetchIdentityArtifacts = startOnce('identity artifact warm-up', async () => {
  const startedAt = Date.now()
  // `publishRow` is the circuit registration proves, and fetching it also warms the SRS for its K —
  // which is shared, so every later circuit on the same K skips that download too.
  // No catch here on purpose: `startOnce` logs the failure and re-arms, so catching would be a
  // second error path for one failure.
  await ensureCircuitArtifacts('publishRow', 'identity')
  logger.info('identity circuit artifacts are warm', {origin: ORIGIN, ms: Date.now() - startedAt})
})
