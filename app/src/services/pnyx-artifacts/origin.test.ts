/**
 * Artifact-origin selection and the manifest/contract agreement check.
 *
 * `EXPO_PUBLIC_*` is inlined at bundle time, so the reads are literal member expressions the tests
 * cannot parameterise — hence the `process.env` mutation rather than a factory argument.
 */

import {afterEach, describe, expect, it} from 'vitest'
import {MissingEnvError} from '../../config/env'
import {artifactSource, artifactsOrigin, manifestMismatch} from './origin'

const original = process.env.EXPO_PUBLIC_ARTIFACTS_URL

afterEach(() => {
  if (original === undefined) delete process.env.EXPO_PUBLIC_ARTIFACTS_URL
  else process.env.EXPO_PUBLIC_ARTIFACTS_URL = original
})

describe('artifactsOrigin', () => {
  it.each([[undefined], [''], ['   ']])('throws rather than falling back for %s', (value) => {
    if (value === undefined) delete process.env.EXPO_PUBLIC_ARTIFACTS_URL
    else process.env.EXPO_PUBLIC_ARTIFACTS_URL = value

    // The removed fallback fetched artifacts from the content service's /chain/* routes. Right for a
    // local chain, 503 against the hosted Worker — and the failure arrived as "identity has not been
    // registered", several layers from the cause.
    expect(() => artifactsOrigin()).toThrow(MissingEnvError)
  })

  // A trailing slash in the env var is the classic source of `//` in every URL built from it.
  it('strips trailing slashes', () => {
    process.env.EXPO_PUBLIC_ARTIFACTS_URL = 'https://artifacts.example/'
    expect(artifactsOrigin()).toBe('https://artifacts.example')
  })
})

describe('artifactSource', () => {
  // Circuit files are keyed by contract address so a redeploy that has not been uploaded 404s rather
  // than serving prover keys for circuits nobody is proving.
  it('keys circuit files by contract target, and shares the SRS', () => {
    process.env.EXPO_PUBLIC_ARTIFACTS_URL = 'https://artifacts.example'
    const source = artifactSource('circle')
    expect(source.manifest).toBe('https://artifacts.example/circle/manifest.json')
    expect(source.circuit('castVote', 'prover')).toBe('https://artifacts.example/circle/castVote.prover')
    // Contract-independent: not under the target, so one copy serves every contract.
    expect(source.params('15')).toBe('https://artifacts.example/params/bls_midnight_2p15')
  })

  // The two contracts have disjoint circuit sets, so their artifacts cannot share a prefix.
  it('separates the identity and circle contracts', () => {
    process.env.EXPO_PUBLIC_ARTIFACTS_URL = 'https://artifacts.example'
    expect(artifactSource('identity').manifest).not.toBe(artifactSource('circle').manifest)
  })

  // A local service can still serve them — it is just declared, not inferred.
  it('serves a local content service when the build points at its /chain prefix', () => {
    process.env.EXPO_PUBLIC_ARTIFACTS_URL = 'http://10.0.2.2:3300/chain'
    expect(artifactSource('circle').manifest).toBe('http://10.0.2.2:3300/chain/circle/manifest.json')
  })
})

describe('manifestMismatch', () => {
  it('accepts a manifest for the requested target', () => {
    expect(manifestMismatch('circle', 'circle')).toBeUndefined()
    expect(manifestMismatch('identity', 'identity')).toBeUndefined()
  })

  // The check exists because a stale bucket makes this reachable, and the resulting node rejection
  // (verifier key mismatch) names nothing that would lead a reader back here.
  //
  // Targets are exact, not case-insensitive as addresses were: they are fixed identifiers this code
  // supplies, so a case difference means something built the URL wrongly.
  it('names both targets when they disagree', () => {
    expect(manifestMismatch('identity', 'circle')).toContain('identity')
    expect(manifestMismatch('identity', 'circle')).toContain('circle')
    expect(manifestMismatch('Circle', 'circle')).toBeDefined()
  })
})
