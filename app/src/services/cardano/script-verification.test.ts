import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  clearScriptVerificationCache,
  fetchScriptVerification,
  fetchScriptVerifications,
  verdictFromRegistry,
} from './script-verification'

const HASH = 'bed5d7376b5bfc022bb9194fe0b010786564854f8321362dfe2caebb'
const OTHER = 'a1'.repeat(28)
const BASE = 'https://registry.example.com'

const record = (over: Record<string, unknown> = {}) => ({
  txHash: 'a5'.repeat(32),
  sourceUrl: 'https://github.com/example/contract',
  commitHash: '97ee72fcfe33d0cbf739f296069e3c94243f6228',
  sourcePath: '',
  compilerType: 'AIKEN',
  compilerVersion: 'v1.1.9',
  env: null,
  status: 'VERIFIED',
  scripts: [{scriptName: 'oracle', rawHash: HASH, finalHash: null, plutusVersion: 'V3'}],
  ...over,
})

describe('verdictFromRegistry', () => {
  it('reports a VERIFIED record whose script list contains the hash', () => {
    const v = verdictFromRegistry(HASH, record())
    expect(v.status).toBe('verified')
    if (v.status !== 'verified') return
    expect(v.sourceUrl).toBe('https://github.com/example/contract')
    expect(v.compilerVersion).toBe('v1.1.9')
    expect(v.env).toBeNull()
  })

  it('matches a parameterized instance on its finalHash too', () => {
    const v = verdictFromRegistry(OTHER, record({scripts: [{rawHash: HASH, finalHash: OTHER}]}))
    expect(v.status).toBe('verified')
  })

  it('refuses a record that does not list the hash we asked about', () => {
    expect(verdictFromRegistry(OTHER, record()).status).toBe('unverified')
  })

  it('refuses a record that is not VERIFIED, whatever else it says', () => {
    expect(verdictFromRegistry(HASH, record({status: 'PENDING'})).status).toBe('unverified')
    expect(verdictFromRegistry(HASH, record({status: 'FAILED'})).status).toBe('unverified')
  })

  it('refuses a VERIFIED record with no source or commit — it describes nothing checkable', () => {
    expect(verdictFromRegistry(HASH, record({sourceUrl: ''})).status).toBe('unverified')
    expect(verdictFromRegistry(HASH, record({commitHash: undefined})).status).toBe('unverified')
  })

  it('keeps a non-empty env, which is part of reproducing the build', () => {
    const v = verdictFromRegistry(HASH, record({env: 'mainnet'}))
    expect(v.status === 'verified' && v.env).toBe('mainnet')
  })

  it('treats junk as unverified rather than throwing', () => {
    expect(verdictFromRegistry(HASH, null).status).toBe('unverified')
    expect(verdictFromRegistry(HASH, 'nope').status).toBe('unverified')
    expect(verdictFromRegistry(HASH, {}).status).toBe('unverified')
  })
})

describe('fetchScriptVerification', () => {
  beforeEach(() => {
    clearScriptVerificationCache()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks the registry by hash and reports the verdict', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(record()), {status: 200}))
    vi.stubGlobal('fetch', fetchMock)
    const v = await fetchScriptVerification(HASH, {baseUrl: BASE})
    expect(v.status).toBe('verified')
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/v1/scripts/by-hash/${HASH}`, expect.anything())
  })

  it('reads a 404 as "no record" — an answer, not a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', {status: 404})),
    )
    expect((await fetchScriptVerification(HASH, {baseUrl: BASE})).status).toBe('unverified')
  })

  it('a 500 is unknown, never "unverified" — the contract was not asked about', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', {status: 500})),
    )
    const v = await fetchScriptVerification(HASH, {baseUrl: BASE})
    expect(v.status).toBe('unknown')
    if (v.status === 'unknown') expect(v.reason).toBe('http-500')
  })

  it('a thrown request is unknown, and the failure is not cached', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('offline')
    })
    vi.stubGlobal('fetch', fetchMock)
    expect((await fetchScriptVerification(HASH, {baseUrl: BASE})).status).toBe('unknown')
    expect((await fetchScriptVerification(HASH, {baseUrl: BASE})).status).toBe('unknown')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('caches an answer, so a second ask makes no request', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(record()), {status: 200}))
    vi.stubGlobal('fetch', fetchMock)
    await fetchScriptVerification(HASH, {baseUrl: BASE})
    await fetchScriptVerification(HASH.toUpperCase(), {baseUrl: BASE})
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('makes no request at all when no registry is configured', async () => {
    const fetchMock = vi.fn(async () => new Response('', {status: 200}))
    vi.stubGlobal('fetch', fetchMock)
    const v = await fetchScriptVerification(HASH, {baseUrl: undefined})
    expect(v.status).toBe('unknown')
    if (v.status === 'unknown') expect(v.reason).toBe('no-registry-configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers each hash independently — one failure does not colour the others', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith(OTHER) ? new Response('', {status: 503}) : new Response(JSON.stringify(record()), {status: 200}),
      ),
    )
    const map = await fetchScriptVerifications([HASH, OTHER], {baseUrl: BASE})
    expect(map.get(HASH)?.status).toBe('verified')
    expect(map.get(OTHER)?.status).toBe('unknown')
  })
})

/*
 * Hermes (React Native) ships `AbortController` but NOT the `AbortSignal.timeout` /
 * `AbortSignal.any` statics. Reaching for them threw before `fetch` was ever called, so on
 * device every script rendered "could not check" and no request left the phone — invisible to
 * a Node test run, where both statics exist. Found by driving the review on the emulator
 * 2026-09-30; the same note already lived in `pnyx-session.ts`.
 */
describe('on a runtime without the AbortSignal statics', () => {
  const statics = {timeout: AbortSignal.timeout, any: AbortSignal.any}

  beforeEach(() => {
    clearScriptVerificationCache()
    // @ts-expect-error — modelling Hermes, where these are simply absent.
    AbortSignal.timeout = undefined
    // @ts-expect-error — same.
    AbortSignal.any = undefined
  })

  afterEach(() => {
    AbortSignal.timeout = statics.timeout
    AbortSignal.any = statics.any
    vi.restoreAllMocks()
  })

  it('still reaches the registry and reports its answer', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ok: true, status: 200, json: async () => record()})
    vi.stubGlobal('fetch', fetchMock)

    const v = await fetchScriptVerification(HASH, {baseUrl: BASE})

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(v.status).toBe('verified')
  })

  it('passes an abortable signal rather than none at all', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ok: true, status: 200, json: async () => record()})
    vi.stubGlobal('fetch', fetchMock)

    await fetchScriptVerification(HASH, {baseUrl: BASE})

    const init = fetchMock.mock.calls[0]?.[1] as {signal?: AbortSignal}
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.signal?.aborted).toBe(false)
  })

  it("honours a caller's signal that is already aborted", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ok: true, status: 200, json: async () => record()})
    vi.stubGlobal('fetch', fetchMock)

    await fetchScriptVerification(HASH, {baseUrl: BASE, signal: AbortSignal.abort()})

    const init = fetchMock.mock.calls[0]?.[1] as {signal?: AbortSignal}
    expect(init.signal?.aborted).toBe(true)
  })
})
