import {Effect} from 'effect'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {classifySignInError, refreshSessionToken, SignInError, signInWithMidnight} from './pnyx-session'

// Real by default — only the concurrency test overrides it, and `mockRejectedValueOnce` self-clears.
const {mnemonicToSeed} = vi.hoisted(() => ({mnemonicToSeed: vi.fn()}))

const {audit} = vi.hoisted(() => ({audit: {recordInfraSignature: vi.fn(async () => undefined)}}))
vi.mock('./signing-audit', () => audit)

const {reg, publish, mls, contract} = vi.hoisted(() => ({
  reg: {
    isIdentityRegistered: vi.fn<() => boolean>(() => false),
    markIdentityRegistered: vi.fn(async () => undefined),
    clearIdentityRegistered: vi.fn(async () => undefined),
  },
  publish: {ensureIdentityRegistered: vi.fn(async () => true)},
  mls: {deriveMlsIdentity: vi.fn()},
  // The address is derived, not configured, and the derivation is native — so it is stubbed with the
  // fixed value the cache-scope assertions below expect.
  contract: {identityContractAddressFor: vi.fn(async () => new Uint8Array(32).fill(0xab))},
}))

vi.mock('./identity-registration-cache', () => reg)
// The two modules sign-in imports lazily. Stubbed so "did registration run?" is observable without
// dragging the native prover and the MLS stack into the test.
vi.mock('./identity-publish', () => publish)
vi.mock('./identity-contract', () => contract)
vi.mock('./dm-mls', () => mls)
vi.mock('@pnyx/wallet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pnyx/wallet')>()
  mnemonicToSeed.mockImplementation(actual.mnemonicToSeed)
  return {...actual, mnemonicToSeed}
})

describe('signInWithMidnight network guard', () => {
  // Registration is no longer gated on a configured contract address — there is none — so the lazily
  // imported MLS + publish pair is reached on every sign-in and needs a usable stub even in the tests
  // that are only about the guard.
  beforeEach(() => {
    mls.deriveMlsIdentity
      .mockReset()
      .mockReturnValue(Effect.succeed({signKey: new Uint8Array(32), publicKey: new Uint8Array(32).fill(7)}))
    publish.ensureIdentityRegistered.mockReset().mockResolvedValue(true)
  })

  afterEach(() => {
    delete process.env.EXPO_PUBLIC_PNYX_NETWORK
    vi.unstubAllGlobals()
  })

  const configOnly = (network: string) =>
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.endsWith('/auth/config')) {
          return Promise.resolve(new Response(JSON.stringify({domain: 'pnyx.test', network}), {status: 200}))
        }
        throw new Error(`sign-in continued past the guard and called ${url}`)
      }),
    )

  it('refuses to sign in when the service serves a different network than the build declares', async () => {
    process.env.EXPO_PUBLIC_PNYX_NETWORK = 'preprod'
    configOnly('undeployed')

    // Rejects before /auth/nonce and before any derivation — the stub throws if either is reached.
    const error = await signInWithMidnight('any mnemonic').then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(SignInError)
    expect((error as SignInError).step).toBe('network')
    expect(classifySignInError(error)).toBe('misconfigured')
  })

  it('proceeds past the guard when the declared and reported networks agree', async () => {
    process.env.EXPO_PUBLIC_PNYX_NETWORK = 'preprod'
    configOnly('preprod')

    // Agreement means the guard is transparent: sign-in goes on to /auth/nonce, which the stub
    // refuses. Asserting *that* step rather than "not network" is what keeps this from passing
    // vacuously if the guard ever started rejecting for another reason.
    const error = await signInWithMidnight('any mnemonic').then(
      () => undefined,
      (e: unknown) => e,
    )
    expect((error as SignInError | undefined)?.step).toBe('nonce')
  })

  it('issues the nonce without waiting on it, so derivation and registration overlap the round trip', async () => {
    process.env.EXPO_PUBLIC_PNYX_NETWORK = 'preprod'
    let nonceRequested = false
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.endsWith('/auth/config')) {
          return Promise.resolve(new Response(JSON.stringify({domain: 'pnyx.test', network: 'preprod'}), {status: 200}))
        }
        if (url.endsWith('/auth/nonce')) {
          nonceRequested = true
          // Never settles. Awaiting the nonce before deriving — the shape this replaced — parks
          // sign-in here forever, so observing the derivation failure at all is the assertion.
          return new Promise<Response>(() => {})
        }
        throw new Error(`unexpected request to ${url}`)
      }),
    )
    mnemonicToSeed.mockRejectedValueOnce(new Error('enclave handed back garbage'))

    const error = await signInWithMidnight('any mnemonic').then(
      () => undefined,
      (e: unknown) => e,
    )

    expect(nonceRequested).toBe(true)
    expect((error as SignInError | undefined)?.step).toBe('derive')
    // Short timeout on purpose: the regression this guards parks on the unsettled nonce, and the
    // repo-wide 120 s `testTimeout` would turn that into a two-minute stall instead of a failure.
  }, 5_000)
})

describe('registration shortcut', () => {
  /** What the stubbed derivation returns, hex — the scope every cache assertion below is keyed on. */
  const ADDRESS = 'ab'.repeat(32)
  const MNEMONIC = 'test test test test test test test test test test test junk'

  const fullService = (identityResponse: () => Response) =>
    vi.fn((url: string) => {
      if (url.endsWith('/auth/config')) {
        return Promise.resolve(new Response(JSON.stringify({domain: 'pnyx.test', network: 'preprod'}), {status: 200}))
      }
      if (url.endsWith('/auth/nonce')) {
        return Promise.resolve(new Response(JSON.stringify({nonce: 'nonce-123'}), {status: 200}))
      }
      if (url.endsWith('/auth/identity')) return Promise.resolve(identityResponse())
      return Promise.reject(new Error(`unstubbed ${url}`))
    })

  const ok = () => new Response(JSON.stringify({token: 'jwt-abc'}), {status: 200})

  beforeEach(() => {
    process.env.EXPO_PUBLIC_PNYX_NETWORK = 'preprod'
    reg.isIdentityRegistered.mockReset().mockReturnValue(false)
    reg.markIdentityRegistered.mockReset().mockResolvedValue(undefined)
    reg.clearIdentityRegistered.mockReset().mockResolvedValue(undefined)
    publish.ensureIdentityRegistered.mockReset().mockResolvedValue(true)
    mls.deriveMlsIdentity
      .mockReset()
      .mockReturnValue(Effect.succeed({signKey: new Uint8Array(32), publicKey: new Uint8Array(32).fill(7)}))
  })

  afterEach(() => {
    delete process.env.EXPO_PUBLIC_PNYX_NETWORK
    vi.unstubAllGlobals()
  })

  it('reads the chain to confirm the row when nothing is cached', async () => {
    vi.stubGlobal('fetch', fullService(ok))

    await expect(signInWithMidnight(MNEMONIC)).resolves.toMatchObject({token: 'jwt-abc'})
    expect(publish.ensureIdentityRegistered).toHaveBeenCalledTimes(1)
  })

  it('skips the chain read entirely once a previous login proved the row', async () => {
    reg.isIdentityRegistered.mockReturnValue(true)
    vi.stubGlobal('fetch', fullService(ok))

    await expect(signInWithMidnight(MNEMONIC)).resolves.toMatchObject({token: 'jwt-abc'})
    // The saving is this call not happening: it is a marker query, a ~20 kB ledger download and a
    // native decode. Deriving MLS is skipped with it, since its only use was the row's anchor.
    expect(publish.ensureIdentityRegistered).not.toHaveBeenCalled()
    expect(mls.deriveMlsIdentity).not.toHaveBeenCalled()
  })

  it('records the row only after the token comes back', async () => {
    vi.stubGlobal('fetch', fullService(ok))

    await signInWithMidnight(MNEMONIC)
    // Scoped so a redeploy or a network change cannot read as registered.
    expect(reg.markIdentityRegistered).toHaveBeenCalledWith(
      expect.objectContaining({network: 'preprod', contractAddress: ADDRESS}),
    )
  })

  it('does not record anything when the login is refused', async () => {
    vi.stubGlobal(
      'fetch',
      fullService(() => new Response('nope', {status: 401})),
    )

    await expect(signInWithMidnight(MNEMONIC)).rejects.toBeInstanceOf(SignInError)
    expect(reg.markIdentityRegistered).not.toHaveBeenCalled()
  })

  it('forgets a cached row when the login it shortcut is refused, so the next attempt re-registers', async () => {
    reg.isIdentityRegistered.mockReturnValue(true)
    vi.stubGlobal(
      'fetch',
      fullService(() => new Response('no such row', {status: 401})),
    )

    await expect(signInWithMidnight(MNEMONIC)).rejects.toBeInstanceOf(SignInError)
    // Without this a row lost under an unchanged contract address — the one case the key cannot
    // discriminate — would fail every future login identically.
    expect(reg.clearIdentityRegistered).toHaveBeenCalledTimes(1)
  })

  it('leaves the flag alone when a refusal follows a full chain check', async () => {
    vi.stubGlobal(
      'fetch',
      fullService(() => new Response('bad signature', {status: 401})),
    )

    await expect(signInWithMidnight(MNEMONIC)).rejects.toBeInstanceOf(SignInError)
    // Nothing was shortcut, so there is no stale belief to clear — and clearing would mask that the
    // refusal came from somewhere else entirely.
    expect(reg.clearIdentityRegistered).not.toHaveBeenCalled()
  })
})

describe('classifySignInError', () => {
  it('maps config/nonce failures to unreachable (service never answered)', () => {
    expect(classifySignInError(new SignInError('config', 'unreachable'))).toBe('unreachable')
    expect(classifySignInError(new SignInError('nonce', '/auth/nonce responded 503'))).toBe('unreachable')
  })

  it('maps a network mismatch to misconfigured, not unreachable', () => {
    // The service answered; it is simply not the network this build derives identities for, so
    // "check your connection and try again" would be a lie and retrying cannot help.
    const error = new SignInError('network', "identity network mismatch: 'preprod' vs 'undeployed'")
    expect(classifySignInError(error)).toBe('misconfigured')
  })

  it('maps an exchange failure with a network cause to unreachable', () => {
    const error = new SignInError('exchange', 'unreachable during token exchange', new TypeError('failed'))
    expect(classifySignInError(error)).toBe('unreachable')
  })

  it('maps an exchange refusal (HTTP response, no cause) to rejected', () => {
    expect(classifySignInError(new SignInError('exchange', 'login rejected (401): bad signature'))).toBe('rejected')
  })

  it('maps derivation failures to wallet', () => {
    expect(classifySignInError(new SignInError('derive', 'derivation failed', new Error('bad seed')))).toBe('wallet')
  })

  it('maps an unrecognised throw to unknown, not to wallet', () => {
    // Folding these into `wallet` claimed the enclave had refused. It is how a React Native
    // dev-bundle error ("Cannot read property 'reload' of undefined") surfaced as "your wallet keys
    // could not be unlocked" — and, via signInForUnlock, also kept the app locked.
    expect(classifySignInError(new TypeError("Cannot read property 'reload' of undefined"))).toBe('unknown')
    expect(classifySignInError(undefined)).toBe('unknown')
  })
})

/**
 * A refresh is the exchange half of sign-in and nothing else.
 *
 * These assert the *absences* as much as the result: no seed, no enclave, no registration. Those are
 * the whole reason a lapsed session no longer costs a biometric prompt, and each is the sort of step
 * that gets quietly reintroduced by a later refactor.
 */
describe('refreshSessionToken', () => {
  const root = new Uint8Array(32).fill(3)
  const session = {
    token: 'old.token.here',
    network: 'preprod',
    forumRoot: root,
    identity: 'stale-id',
    receivedAtMs: 1_700_000_000_000,
  }

  const tokenWithLife = (iat: number, exp: number): string => {
    const payload = Buffer.from(JSON.stringify({iat, exp})).toString('base64url')
    return `h.${payload}.s`
  }

  const serviceAnswering = (token: string, status = 200) => {
    const posted: {body?: string} = {}
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith('/auth/config')) {
          return Promise.resolve(new Response(JSON.stringify({domain: 'pnyx.test', network: 'preprod'}), {status: 200}))
        }
        if (url.endsWith('/auth/nonce')) {
          return Promise.resolve(new Response(JSON.stringify({nonce: 'nonce-1'}), {status: 200}))
        }
        if (url.endsWith('/auth/identity')) {
          posted.body = init?.body as string
          return Promise.resolve(new Response(JSON.stringify({token}), {status}))
        }
        throw new Error(`unexpected request to ${url}`)
      }),
    )
    return posted
  }

  beforeEach(() => {
    process.env.EXPO_PUBLIC_PNYX_NETWORK = 'preprod'
    mnemonicToSeed.mockClear()
    publish.ensureIdentityRegistered.mockClear()
    reg.clearIdentityRegistered.mockClear()
    audit.recordInfraSignature.mockClear()
  })

  afterEach(() => {
    delete process.env.EXPO_PUBLIC_PNYX_NETWORK
    vi.unstubAllGlobals()
  })

  it('mints a new token from the cached forum root, touching neither the seed nor registration', async () => {
    const posted = serviceAnswering(tokenWithLife(1_700_000_000, 1_700_003_600))

    const next = await refreshSessionToken(session)

    expect(next.token).not.toBe(session.token)
    expect(next.lifetime).toEqual({issuedAtSecs: 1_700_000_000, expiresAtSecs: 1_700_003_600})
    // The enclave is the prompt; not deriving a seed is what makes this silent.
    expect(mnemonicToSeed).not.toHaveBeenCalled()
    // Registration reaches the native prover and the chain — a refresh that ran it would cost more
    // than the sign-in it is meant to avoid.
    expect(publish.ensureIdentityRegistered).not.toHaveBeenCalled()
    // The identity is re-derived from the root rather than carried over, so a session holding a stale
    // id cannot sign a challenge for one identity and keep naming another.
    expect(next.identity).not.toBe('stale-id')
    expect(JSON.parse(posted.body ?? '{}')).toMatchObject({identity: next.identity, nonce: 'nonce-1'})
  })

  // A background signature is exactly the kind that must not be invisible: the audit exists so an
  // unexplained one can be found, and one nobody tapped for is the hardest to explain after the fact.
  it('records the refresh signature in the signing audit', async () => {
    serviceAnswering(tokenWithLife(1, 3601))
    await refreshSessionToken(session)
    expect(audit.recordInfraSignature).toHaveBeenCalledWith(expect.objectContaining({purpose: 'identity-login'}))
  })

  // A refusal is the one signal the row we never read may be gone; clearing the flag is what makes the
  // next full sign-in re-register instead of failing identically for ever.
  it('clears the cached registration when the service refuses', async () => {
    serviceAnswering('unused', 401)

    const error = await refreshSessionToken(session).then(
      () => undefined,
      (e: unknown) => e,
    )

    expect((error as SignInError | undefined)?.step).toBe('exchange')
    expect(classifySignInError(error)).toBe('rejected')
    expect(reg.clearIdentityRegistered).toHaveBeenCalled()
  })

  it('refuses a session with no forum root rather than signing with nothing', async () => {
    const error = await refreshSessionToken({
      token: 't',
      network: 'preprod',
      receivedAtMs: 1_700_000_000_000,
      identity: 'x',
    }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect((error as SignInError | undefined)?.step).toBe('derive')
  })

  // Derived, not configured, and the derivation reaches the native module — so paying for it on every
  // refresh would put the one expensive step back into the cheap path.
  it('derives the contract address once per identity, not once per refresh', async () => {
    serviceAnswering(tokenWithLife(1, 3601))
    await refreshSessionToken(session)
    const after = contract.identityContractAddressFor.mock.calls.length
    await refreshSessionToken(session)
    expect(contract.identityContractAddressFor.mock.calls.length).toBe(after)
  })
})
