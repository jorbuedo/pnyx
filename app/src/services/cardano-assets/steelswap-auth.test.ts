import {Effect} from 'effect'
import {beforeEach, describe, expect, it} from 'vitest'
import {getCardanoAssetsConfig} from './config'
import {
  getSteelswapKey,
  invalidateSteelswapKey,
  resetSteelswapAuth,
  type SteelswapSigner,
  setSteelswapKeyStore,
  setSteelswapSigner,
} from './steelswap-auth'
import {steelswapCredentialState} from './steelswap-credential-state'
import type {FetchLike} from './token-metadata'

const CONFIG = getCardanoAssetsConfig('mainnet')
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)

// A signer that records the payload it was asked to sign.
const stubSigner = (): SteelswapSigner & {readonly signed: () => string | null} => {
  let signed: string | null = null
  return {
    addressBech32: 'addr1_test',
    sign: async (payloadHex: string) => {
      signed = payloadHex
      return {signature: 'cose-sig', key: 'cose-key'}
    },
    signed: () => signed,
  }
}

// Full CIP-8 fetch stub: challenge → verify → keys. `activeKeys` makes the
// server behave like one that still holds a key we lost locally (the 409 path).
const cip8Stub = (opts: {readonly activeKeys?: readonly string[]} = {}) => {
  let keysMinted = 0
  let active = [...(opts.activeKeys ?? [])]
  const revoked: string[] = []
  const fetchImpl: FetchLike = (url, init) => {
    if (url.includes('/api/v2/auth/cip8/challenge')) {
      return Promise.resolve({ok: true, status: 200, json: async () => ({challenge: {}, message: 'sign-me'})})
    }
    if (url.includes('/api/v2/auth/cip8/verify')) {
      return Promise.resolve({ok: true, status: 200, json: async () => ({access_token: 'access-jwt', expires_in: 900})})
    }
    const keyDelete = /\/api\/v2\/auth\/keys\/(.+)$/.exec(url)
    if (keyDelete !== null && init?.method === 'delete') {
      const prefix = keyDelete[1] as string
      active = active.filter((p) => p !== prefix)
      revoked.push(prefix)
      return Promise.resolve({ok: true, status: 204, json: async () => null})
    }
    if (url.includes('/api/v2/auth/keys')) {
      if (init?.method === 'get') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => active.map((prefix) => ({prefix, is_active: true, created_at: 'now'})),
        })
      }
      // The API mints at most one active key per account.
      if (active.length > 0) return Promise.resolve({ok: false, status: 409, json: async () => ({error: 'conflict'})})
      keysMinted += 1
      const prefix = `pf${keysMinted}`
      active.push(prefix)
      return Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({api_key: `durable-${keysMinted}`, prefix}),
      })
    }
    throw new Error(`unexpected url ${url}`)
  }
  return {fetchImpl, keysMinted: () => keysMinted, revoked: () => revoked}
}

const utf8ToHex = (s: string) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('')

describe('the signer is built only when a key must be minted', () => {
  // ⚠️ The reason this is lazy: building the signer reads the identity vault and derives
  // a CIP-1852 key — PBKDF2 in JS, 14.8 s of a 61 s boot on a device. A durable key that
  // is already persisted never needs one.
  it('a persisted key answers without ever calling the signer thunk', async () => {
    resetSteelswapAuth()
    let built = 0
    const store = new Map<string, string>([['@pnyx/steelswap-key/mainnet', 'stored-key']])
    setSteelswapKeyStore({
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => void store.set(k, v),
      remove: async (k) => void store.delete(k),
    })
    setSteelswapSigner(async () => {
      built += 1
      return stubSigner()
    })

    const key = await Effect.runPromise(
      getSteelswapKey(CONFIG, (() => {
        throw new Error('the network must not be touched when a key is stored')
      }) as never),
    )

    expect(key).toBe('stored-key')
    expect(built, 'the thunk was resolved for a key that was already on disk').toBe(0)
    setSteelswapKeyStore(null)
  })

  it('resolves the thunk when there is nothing to answer from', async () => {
    resetSteelswapAuth()
    let built = 0
    setSteelswapSigner(async () => {
      built += 1
      return stubSigner()
    })
    // No key store bound and no RAM entry, so this reaches the mint branch. The mint
    // itself needs the network, which this test does not provide — the thunk having been
    // resolved is the whole assertion.
    await Effect.runPromiseExit(
      getSteelswapKey(CONFIG, (async () => {
        throw new Error('no network in this test')
      }) as never),
    )
    expect(built).toBe(1)
  })
})

describe('getSteelswapKey (CIP-8 durable)', () => {
  beforeEach(async () => {
    setSteelswapSigner(null)
    resetSteelswapAuth()
    invalidateSteelswapKey(CONFIG)
    // Let the best-effort async storage.remove settle before the next case.
    await new Promise((r) => setTimeout(r, 0))
  })

  it('mints a durable key via challenge→sign→verify→keys and caches it', async () => {
    const {fetchImpl, keysMinted} = cip8Stub()
    const signer = stubSigner()
    setSteelswapSigner(signer)
    expect(await run(getSteelswapKey(CONFIG, fetchImpl))).toBe('durable-1')
    // The signer signed the hex of the challenge message.
    expect(signer.signed()).toBe(utf8ToHex('sign-me'))
    // Second call is served from cache — no second mint.
    expect(await run(getSteelswapKey(CONFIG, fetchImpl))).toBe('durable-1')
    expect(keysMinted()).toBe(1)
  })

  it('two concurrent callers share one mint, not two', async () => {
    // Six requests against a daily quota instead of three, and the losing
    // `auth/keys` answers 500. Seen live when the price sweep and the swap
    // estimate both started with no key cached.
    const {fetchImpl, keysMinted} = cip8Stub()
    setSteelswapSigner(stubSigner())
    const [a, b] = await Promise.all([run(getSteelswapKey(CONFIG, fetchImpl)), run(getSteelswapKey(CONFIG, fetchImpl))])
    expect(a).toBe('durable-1')
    expect(b).toBe('durable-1')
    expect(keysMinted()).toBe(1)
  })

  it('re-mints after invalidateSteelswapKey', async () => {
    const {fetchImpl, keysMinted} = cip8Stub()
    setSteelswapSigner(stubSigner())
    await run(getSteelswapKey(CONFIG, fetchImpl))
    invalidateSteelswapKey(CONFIG)
    await new Promise((r) => setTimeout(r, 0))
    expect(await run(getSteelswapKey(CONFIG, fetchImpl))).toBe('durable-2')
    expect(keysMinted()).toBe(2)
  })

  it('fails when no signer is registered — there is no anonymous path any more', async () => {
    // `POST /api/v2/auth/anon` was removed from the API (404), so a signerless
    // caller must fail loudly rather than fire a request that cannot succeed.
    const {fetchImpl, keysMinted} = cip8Stub()
    await expect(run(getSteelswapKey(CONFIG, fetchImpl))).rejects.toBeDefined()
    expect(keysMinted()).toBe(0)
  })

  it('recovers from a 409 by revoking the stale active key, then re-minting', async () => {
    // The server still holds a key from a previous install; ours is gone with
    // the cleared storage. Without the revoke the account can never mint again.
    const {fetchImpl, keysMinted, revoked} = cip8Stub({activeKeys: ['stale-prefix']})
    setSteelswapSigner(stubSigner())
    expect(await run(getSteelswapKey(CONFIG, fetchImpl))).toBe('durable-1')
    expect(revoked()).toEqual(['stale-prefix'])
    expect(keysMinted()).toBe(1)
  })

  it('surfaces a mint failure (challenge non-2xx) as an auth error', async () => {
    const fetchImpl: FetchLike = (url) =>
      url.includes('/cip8/challenge')
        ? Promise.resolve({ok: false, status: 500, json: async () => ({})})
        : Promise.reject(new Error('should not reach'))
    setSteelswapSigner(stubSigner())
    await expect(run(getSteelswapKey(CONFIG, fetchImpl))).rejects.toBeDefined()
  })
})

describe('the Pnyx partner key', () => {
  // ⚠️ Why these exist: a build that holds the partner key but falls back to a per-install CIP-8
  // key still *works* — every route authenticates. It just pays the swap fee to the user's own
  // auto-provisioned account instead of to Pnyx, and nothing in the UI or the logs says so. The
  // fallback succeeding is exactly what makes it dangerous, so the precedence is pinned here.
  const PARTNER = {...CONFIG, steelswapPartnerKey: 'partner-key'} as const

  beforeEach(async () => {
    setSteelswapSigner(null)
    setSteelswapKeyStore(null)
    resetSteelswapAuth()
    await new Promise((r) => setTimeout(r, 0))
  })

  it('answers with the partner key and never mints, even with a signer registered', async () => {
    const {fetchImpl, keysMinted} = cip8Stub()
    setSteelswapSigner(stubSigner())
    expect(await run(getSteelswapKey(PARTNER, fetchImpl))).toBe('partner-key')
    expect(keysMinted(), 'a mint ran while a partner key was configured').toBe(0)
    expect(steelswapCredentialState().tag).toBe('partner')
  })

  it('outranks a key already persisted for this network', async () => {
    const store = new Map<string, string>([['@pnyx/steelswap-key/mainnet', 'stored-key']])
    setSteelswapKeyStore({
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => void store.set(k, v),
      remove: async (k) => void store.delete(k),
    })
    const {fetchImpl} = cip8Stub()
    expect(await run(getSteelswapKey(PARTNER, fetchImpl))).toBe('partner-key')
    setSteelswapKeyStore(null)
  })

  it('is not invalidated by a 401, and says so, because the app cannot re-mint it', async () => {
    // Our partner account carries no `maintenance_address`, so the CIP-8 login that mints and
    // revokes keys cannot resolve to it. Clearing a cache here would hide a revoked credential
    // behind a mint whose result the next call could not use.
    expect(invalidateSteelswapKey(PARTNER)).toBe(false)
    expect(steelswapCredentialState().tag).toBe('partnerRejected')

    const {fetchImpl} = cip8Stub()
    expect(await run(getSteelswapKey(PARTNER, fetchImpl))).toBe('partner-key')
  })

  it('still invalidates a per-install key, which is ours to replace', async () => {
    const {fetchImpl} = cip8Stub()
    setSteelswapSigner(stubSigner())
    await run(getSteelswapKey(CONFIG, fetchImpl))
    expect(invalidateSteelswapKey(CONFIG)).toBe(true)
  })
})
