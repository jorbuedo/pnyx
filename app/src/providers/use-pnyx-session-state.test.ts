/**
 * Tests for the Pnyx session state machine — in particular the onboarding
 * auto sign-in (`signInWithMnemonic`): identity login with the in-memory seed,
 * no enclave decrypt, non-blocking failure. The session binds to the identity
 * wallet, not the selected wallet group (identity/wallet split) — switching
 * funds wallets never clears it.
 *
 * Uses the minimal React hook simulation also used by
 * useGuardedNavigation.test.ts so the hook runs outside a real React tree;
 * the content service is a mocked global fetch.
 */

import {beforeEach, describe, expect, it, vi} from 'vitest'

const {sim} = vi.hoisted(() => ({
  sim: {
    states: [] as unknown[],
    stateIdx: 0,
    refs: [] as Array<{current: unknown}>,
    refIdx: 0,
    effects: [] as Array<{deps: unknown[] | undefined; prevDeps: unknown[] | undefined; fn: () => void}>,
    effectIdx: 0,
  },
}))

vi.mock('react', () => ({
  useState: (init: unknown) => {
    const i = sim.stateIdx++
    if (i >= sim.states.length) sim.states.push(typeof init === 'function' ? (init as () => unknown)() : init)
    return [
      sim.states[i],
      (v: unknown) => {
        // biome-ignore lint/complexity/noBannedTypes: test-only React mock needs generic callable cast
        sim.states[i] = typeof v === 'function' ? (v as Function)(sim.states[i]) : v
      },
    ]
  },
  useCallback: (fn: unknown) => fn,
  useMemo: (factory: () => unknown) => factory(),
  useRef: (init: unknown) => {
    const i = sim.refIdx++
    if (i >= sim.refs.length) sim.refs.push({current: init})
    return sim.refs[i]
  },
  // Deps-aware: mirrors React — the effect body only runs when deps change.
  useEffect: (fn: () => void, deps: unknown[] | undefined) => {
    const i = sim.effectIdx++
    const prev = sim.effects[i]
    const entry = {deps, prevDeps: prev?.deps, fn}
    sim.effects[i] = entry
    const changed =
      prev === undefined ||
      deps === undefined ||
      prev.deps === undefined ||
      deps.length !== prev.deps.length ||
      deps.some((d, k) => !Object.is(d, prev.deps?.[k]))
    if (changed) fn()
  },
}))

vi.mock('../logger', () => ({
  logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
}))

vi.mock('../services/pnyx-identity-storage', () => ({
  readPnyxIdentitySync: vi.fn(() => undefined),
  writePnyxIdentity: vi.fn(async () => {}),
  clearPnyxIdentity: vi.fn(async () => {}),
}))

// Mocked for the same reason as the identity store above: it reaches MMKV, which has no node build.
// `restoreSessionSync` answering undefined is the signed-out start every case here assumes; the
// restore path itself is covered by `services/session-store.test.ts`.
vi.mock('../services/session-store', () => ({
  restoreSessionSync: vi.fn(() => undefined),
  writeStoredSession: vi.fn(async () => {}),
  clearStoredSession: vi.fn(async () => {}),
}))

import {type PnyxSessionDeps, usePnyxSessionState} from './use-pnyx-session-state'

// Same fixture mnemonic as packages/wallet/account/derivation/midnight.test.ts.
const TEST_MNEMONIC = 'test test test test test test test test test test test junk'
// `C` for the same mnemonic — pins the whole derivation chain (seed → forumRoot → identitySk →
// identityCommitment → bech32m). The same on every network, which is the point.
// `packages/contract-client/src/identity.test.ts` pins the commitment against the circuit's own
// derivation.
const GOLDEN_PNYX_ID = 'pnyx_id160uq2femu87q0hugnnk7fsk7tmy4jn3vjf62ctp00wwty2tmx3tqhq44tn'

const okJson = (body: unknown): Response =>
  ({ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body)}) as Response

const mockContentService = () =>
  vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    if (path.endsWith('/auth/config')) return okJson({domain: 'pnyx.test', network: 'mainnet'})
    if (path.endsWith('/auth/nonce')) return okJson({nonce: 'nonce-123'})
    if (path.endsWith('/auth/identity')) return okJson({token: 'jwt-abc'})
    throw new Error(`unexpected fetch: ${path}`)
  })

function resetAll() {
  sim.states = []
  sim.refs = []
  sim.effects = []
  sim.stateIdx = 0
  sim.refIdx = 0
  sim.effectIdx = 0
}

/**
 * Let the SIWM exchange that `signInForUnlock` deliberately does not await finish.
 *
 * Unlock resolves at the enclave leg now, so the session and any failure land a few ticks later.
 */
const settleBackgroundSignIn = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function render(deps: PnyxSessionDeps) {
  sim.stateIdx = 0
  sim.refIdx = 0
  sim.effectIdx = 0
  return usePnyxSessionState(deps)
}

describe('usePnyxSessionState — onboarding auto sign-in (signInWithMnemonic)', () => {
  beforeEach(() => {
    resetAll()
    vi.unstubAllGlobals()
  })

  it('signs in with the in-memory identity seed — no enclave decrypt, no OS prompt path', async () => {
    vi.stubGlobal('fetch', mockContentService())
    const decryptIdentityMnemonic = vi.fn(async () => TEST_MNEMONIC)
    const deps: PnyxSessionDeps = {canSignIn: false, decryptIdentityMnemonic}

    const hook = render(deps)
    const session = await hook.signInWithMnemonic(TEST_MNEMONIC)

    expect(decryptIdentityMnemonic).not.toHaveBeenCalled()
    expect(session).toMatchObject({
      token: 'jwt-abc',
      identity: GOLDEN_PNYX_ID,
      network: 'mainnet',
    })

    const after = render(deps)
    expect(after.session).toMatchObject({token: 'jwt-abc', identity: GOLDEN_PNYX_ID})
    // The persisted record is the Pnyx id, not the wallet address: it is what the Id tab shows.
    expect(after.identity).toEqual({pnyxId: GOLDEN_PNYX_ID, network: 'mainnet'})
    expect(after.isSigningIn).toBe(false)
    expect(after.signInError).toBeUndefined()
  })

  it('keeps the session across wallet-group changes — identity is not group-scoped', async () => {
    vi.stubGlobal('fetch', mockContentService())
    const decryptIdentityMnemonic = vi.fn(async () => TEST_MNEMONIC)

    const hook = render({canSignIn: true, decryptIdentityMnemonic})
    await hook.signInWithMnemonic(TEST_MNEMONIC)

    // Any number of re-renders (e.g. the user switches funds wallets) keeps
    // the session — the group-switch invalidation of the pre-split model is
    // deliberately gone.
    render({canSignIn: true, decryptIdentityMnemonic})
    const after = render({canSignIn: true, decryptIdentityMnemonic})
    expect(after.session).toMatchObject({token: 'jwt-abc'})
    expect(after.identity).toBeDefined()
  })

  it('is non-blocking on an unreachable service: resolves undefined and records the failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Network request failed')
      }),
    )
    const decryptIdentityMnemonic = vi.fn(async () => TEST_MNEMONIC)
    const deps: PnyxSessionDeps = {canSignIn: false, decryptIdentityMnemonic}

    const hook = render(deps)
    await expect(hook.signInWithMnemonic(TEST_MNEMONIC)).resolves.toBeUndefined()

    const after = render(deps)
    expect(after.session).toBeUndefined()
    expect(after.signInError).toBe('unreachable')
    expect(after.isSigningIn).toBe(false)
  })

  it('signIn (post-onboarding path) still decrypts through the enclave vault', async () => {
    vi.stubGlobal('fetch', mockContentService())
    const decryptIdentityMnemonic = vi.fn(async () => TEST_MNEMONIC)

    const hook = render({canSignIn: true, decryptIdentityMnemonic})
    const session = await hook.signIn()

    expect(decryptIdentityMnemonic).toHaveBeenCalledTimes(1)
    expect(session).toMatchObject({token: 'jwt-abc', identity: GOLDEN_PNYX_ID})
  })

  it('signIn without an identity resolves undefined without touching the vault', async () => {
    vi.stubGlobal('fetch', mockContentService())
    const decryptIdentityMnemonic = vi.fn(async () => TEST_MNEMONIC)

    const hook = render({canSignIn: false, decryptIdentityMnemonic})
    await expect(hook.signIn()).resolves.toBeUndefined()
    expect(decryptIdentityMnemonic).not.toHaveBeenCalled()
  })

  it('signIn while the identity probe is still resolving (undefined) is a no-op', async () => {
    vi.stubGlobal('fetch', mockContentService())
    const decryptIdentityMnemonic = vi.fn(async () => TEST_MNEMONIC)

    const hook = render({canSignIn: undefined, decryptIdentityMnemonic})
    await expect(hook.signIn()).resolves.toBeUndefined()
    expect(decryptIdentityMnemonic).not.toHaveBeenCalled()
  })

  describe('signInForUnlock (lock-screen ceremony)', () => {
    it('authPassed + signed-in on full success', async () => {
      vi.stubGlobal('fetch', mockContentService())
      const decryptIdentityMnemonic = vi.fn(async () => TEST_MNEMONIC)
      const deps: PnyxSessionDeps = {canSignIn: true, decryptIdentityMnemonic}

      const hook = render(deps)
      await expect(hook.signInForUnlock()).resolves.toEqual({authPassed: true, hadIdentity: true})

      expect(decryptIdentityMnemonic).toHaveBeenCalledTimes(1)
      // The session is not part of unlocking and arrives after it — see `signInForUnlock`.
      await settleBackgroundSignIn()
      const after = render(deps)
      expect(after.session).toMatchObject({token: 'jwt-abc', identity: GOLDEN_PNYX_ID})
    })

    it('authPassed but no session when only the SIWM network leg fails (unlock offline)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('Network request failed')
        }),
      )
      const decryptIdentityMnemonic = vi.fn(async () => TEST_MNEMONIC)
      const deps: PnyxSessionDeps = {canSignIn: true, decryptIdentityMnemonic}

      const hook = render(deps)
      // Decrypt succeeded (the biometric passed); only the service is down.
      await expect(hook.signInForUnlock()).resolves.toEqual({authPassed: true, hadIdentity: true})

      await settleBackgroundSignIn()
      const after = render(deps)
      expect(after.session).toBeUndefined()
      expect(after.signInError).toBe('unreachable')
    })

    // ⚠️ The defect this exists for. Every sign-in leg is a call to a Cloudflare Worker, and a host
    // that accepts the connection and never answers leaves `fetch` pending for ever — no error, so
    // nothing to log or show. Unlock used to await that promise, so the lock screen's spinner ran
    // indefinitely and a person who had already passed the OS prompt could not get into their wallet.
    // Under the old code this test does not fail, it hangs.
    it('unlocks without waiting for a network leg that never answers', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise<Response>(() => {})),
      )
      const decryptIdentityMnemonic = vi.fn(async () => TEST_MNEMONIC)
      const deps: PnyxSessionDeps = {canSignIn: true, decryptIdentityMnemonic}

      const hook = render(deps)
      await expect(hook.signInForUnlock()).resolves.toEqual({authPassed: true, hadIdentity: true})
      expect(decryptIdentityMnemonic).toHaveBeenCalledTimes(1)
    })

    it('authPassed false when the enclave decrypt itself fails (cancelled biometric) — stays locked', async () => {
      vi.stubGlobal('fetch', mockContentService())
      const decryptIdentityMnemonic = vi.fn(async () => {
        throw new Error('auth cancelled')
      })
      const deps: PnyxSessionDeps = {canSignIn: true, decryptIdentityMnemonic}

      const hook = render(deps)
      await expect(hook.signInForUnlock()).resolves.toEqual({authPassed: false, hadIdentity: true})

      const after = render(deps)
      expect(after.session).toBeUndefined()
      expect(after.signInError).toBe('wallet')
    })

    it('stays unlocked when something unexpected throws after the decrypt, and reports it as unknown', async () => {
      // A 200 whose body is not JSON: `response.json()` in the token exchange is outside the
      // SignInError wrapping, so a SyntaxError escapes as a bare throw — the same shape as the
      // React Native dev-bundle TypeError this guards against. The biometric already passed, so
      // locking the app (what classifying it as `wallet` used to do) punishes the user for a
      // service-side fault.
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: RequestInfo | URL) => {
          const path = String(url)
          if (path.endsWith('/auth/config')) return okJson({domain: 'pnyx.test', network: 'mainnet'})
          if (path.endsWith('/auth/nonce')) return okJson({nonce: 'nonce-123'})
          if (path.endsWith('/auth/identity')) {
            return {
              ok: true,
              status: 200,
              json: async () => {
                throw new SyntaxError('Unexpected token < in JSON at position 0')
              },
              text: async () => '<html>gateway</html>',
              // Double cast: the throwing `json` narrows to `Promise<never>`, which TS refuses to
              // relate to `Response` directly.
            } as unknown as Response
          }
          throw new Error(`unexpected fetch: ${path}`)
        }),
      )
      const decryptIdentityMnemonic = vi.fn(async () => TEST_MNEMONIC)
      const deps: PnyxSessionDeps = {canSignIn: true, decryptIdentityMnemonic}

      const hook = render(deps)
      await expect(hook.signInForUnlock()).resolves.toEqual({authPassed: true, hadIdentity: true})

      await settleBackgroundSignIn()
      const after = render(deps)
      expect(after.session).toBeUndefined()
      expect(after.signInError).toBe('unknown')
    })

    it('reports no identity without touching the vault when none exists', async () => {
      vi.stubGlobal('fetch', mockContentService())
      const decryptIdentityMnemonic = vi.fn(async () => TEST_MNEMONIC)

      const hook = render({canSignIn: false, decryptIdentityMnemonic})
      await expect(hook.signInForUnlock()).resolves.toEqual({authPassed: false, hadIdentity: false})
      expect(decryptIdentityMnemonic).not.toHaveBeenCalled()
    })
  })
})
