// Key material for proving a transaction in-process, read from a directory instead of a proof server.
//
// **Why this exists.** Balancing is a proving path. `balanceTx` binds the sponsor's DUST fee to a
// device-proven transaction, and the spend actions it adds are unproven — so the wallet SDK proves
// them, by default through an HTTP proof server (`provingServerUrl`). The sponsor host deliberately
// runs no second service (docs/SPONSOR_HOST.md), so it uses the SDK's in-process `WasmProver`
// instead, and that needs somebody to hand it the four wallet circuits' keys and the KZG SRS.
//
// The SDK's own `makeDefaultKeyMaterialProvider` fetches them from a Midnight-run *dev* S3 bucket on
// every cold cache. A funds-holding host does not take a runtime dependency on a third party's dev
// bucket, so the files are mirrored onto the box once and read from disk (the same reasoning that
// puts our circuit artifacts on our own R2 rather than proxying them).
//
// **Not contract-specific.** These are `zswap/{spend,output,sign}` and `dust/spend` — the fee
// machinery, identical for every deployment. So this adds no per-deployment state to the host: a
// contract redeploy still touches nothing here, which was the property the no-proof-server decision
// was protecting.

import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import type {KeyMaterialProvider} from '@midnight-ntwrk/zkir-v2'

/** One circuit's three files, as the prover wants them. */
export type ProvingKeyMaterial = {
  readonly proverKey: Uint8Array
  readonly verifierKey: Uint8Array
  readonly ir: Uint8Array
}

/**
 * Reads one file, or rejects.
 *
 * Injected so the mapping below is testable without a filesystem — the interesting part is which
 * path a key location resolves to, and that is worth a test that cannot be satisfied by a fixture
 * directory happening to exist.
 */
export type FileReader = (relativePath: string) => Promise<Uint8Array>

/**
 * Key-material version in the upstream layout (`zswap/<ver>/spend`, …).
 *
 * Mirrors the constant in the SDK's `makeDefaultKeyMaterialProvider`, which is not exported. A bump
 * upstream means new files to mirror, so it is a parameter rather than a literal: the fetch script
 * and this provider have to agree, and one place to change beats two to notice.
 */
export const KEY_MATERIAL_VERSION = 9

/** Which relative path (minus extension) holds each key location's material. */
export const keyMaterialPath = (keyLocation: string, version = KEY_MATERIAL_VERSION): string | undefined =>
  ({
    'midnight/zswap/spend': `zswap/${version}/spend`,
    'midnight/zswap/output': `zswap/${version}/output`,
    'midnight/zswap/sign': `zswap/${version}/sign`,
    'midnight/dust/spend': `dust/${version}/spend`,
  })[keyLocation]

/** The SRS file for a given K, in the same layout our R2 uses (`params/bls_midnight_2p<k>`). */
export const paramsPath = (k: number): string => `params/bls_midnight_2p${k}`

/**
 * A {@link KeyMaterialProvider} backed by mirrored files.
 *
 * Caches in memory: the sponsor is one long-lived process, the prover asks for the same four
 * circuits on every transaction, and the largest prover key is ~11 MB — re-reading it per
 * registration would be pure waste.
 *
 * An **unknown** key location returns `undefined`, exactly as the SDK's provider does: that is the
 * prover asking "do you have this?", and the honest answer is no. A **known** location whose file is
 * missing throws naming the path, because that is a broken mirror rather than a question — reporting
 * it as `undefined` would surface later as an opaque proving failure.
 */
export const fileKeyMaterialProvider = (
  read: FileReader,
  options: {readonly version?: number} = {},
): KeyMaterialProvider => {
  const version = options.version ?? KEY_MATERIAL_VERSION
  const keys = new Map<string, ProvingKeyMaterial>()
  const params = new Map<number, Uint8Array>()

  return {
    lookupKey: async (keyLocation: string) => {
      const path = keyMaterialPath(keyLocation, version)
      if (path === undefined) return undefined
      const cached = keys.get(path)
      if (cached !== undefined) return cached
      const [proverKey, verifierKey, ir] = await Promise.all([
        read(`${path}.prover`),
        read(`${path}.verifier`),
        read(`${path}.bzkir`),
      ])
      const material = {proverKey, verifierKey, ir}
      keys.set(path, material)
      return material
    },
    getParams: async (k: number) => {
      const cached = params.get(k)
      if (cached !== undefined) return cached
      const srs = await read(paramsPath(k))
      params.set(k, srs)
      return srs
    },
  }
}

/** {@link fileKeyMaterialProvider} over a mirror on disk. */
export const directoryKeyMaterialProvider = (dir: string, options?: {readonly version?: number}): KeyMaterialProvider =>
  fileKeyMaterialProvider(async (relativePath) => {
    const absolute = join(dir, relativePath)
    try {
      return new Uint8Array(await readFile(absolute))
    } catch (error) {
      throw new Error(
        `proving key material missing: ${absolute} (${error instanceof Error ? error.message : String(error)})`,
      )
    }
  }, options ?? {})
