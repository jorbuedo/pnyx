import {describe, expect, it, vi} from 'vitest'

vi.mock('../../platform/storage', () => ({
  storage: {getSync: () => null, get: vi.fn(), set: vi.fn(), remove: vi.fn()},
  deviceStorage: {getSync: () => null, get: vi.fn(), set: vi.fn(), remove: vi.fn()},
}))

const {clearLockConfig, makeVerifier, parseLockConfig, resolveCode, subscribeLockConfig, writeLockConfig} =
  await import('./pin-config')

const SALT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

const config = (codes: {real: string; decoy?: string; wipe?: string}) => ({
  version: 2 as const,
  mode: 'coldStart' as const,
  salt: SALT,
  verifiers: [
    makeVerifier('real', codes.real, SALT),
    ...(codes.decoy ? [makeVerifier('decoy', codes.decoy, SALT)] : []),
    ...(codes.wipe ? [makeVerifier('wipe', codes.wipe, SALT)] : []),
  ],
})

describe('resolveCode', () => {
  it('matches each configured code to its own kind', () => {
    const c = config({real: '246813', decoy: '975310', wipe: '11223344'})
    expect(resolveCode(c, '246813')).toBe('real')
    expect(resolveCode(c, '975310')).toBe('decoy')
    expect(resolveCode(c, '11223344')).toBe('wipe')
  })

  it('returns undefined for an unknown code — never a fallback profile', () => {
    const c = config({real: '246813', decoy: '975310'})
    expect(resolveCode(c, '000000')).toBeUndefined()
    expect(resolveCode(c, '')).toBeUndefined()
    expect(resolveCode(c, '24681')).toBeUndefined()
  })

  it('does not store the code in recoverable form', () => {
    const c = config({real: '246813'})
    expect(JSON.stringify(c)).not.toContain('246813')
  })

  it('gives different hashes for the same code under different salts', () => {
    const a = makeVerifier('real', '246813', SALT)
    const b = makeVerifier('real', '246813', 'ffffffffffffffffffffffffffffffff')
    expect(a.hash).not.toBe(b.hash)
  })

  it('treats whitespace as content, never trimming it', () => {
    // Same no-trim rule as every other secret in the wallet: a code typed with
    // a space is a different code, not the same one tidied up.
    const c = config({real: ' 1234 '})
    expect(resolveCode(c, ' 1234 ')).toBe('real')
    expect(resolveCode(c, '1234')).toBeUndefined()
  })
})

describe('subscribeLockConfig', () => {
  // Every tab keeps its own AppTopBar instance; without this signal a header
  // mounted before the PIN was set never learns it exists, and the lock button
  // stays hidden on that tab until it remounts.
  it('fires subscribers when the config is written or cleared', async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeLockConfig(listener)

    await writeLockConfig(config({real: '246813'}))
    expect(listener).toHaveBeenCalledTimes(1)

    await clearLockConfig()
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    await writeLockConfig(config({real: '135790'}))
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('parseLockConfig', () => {
  const valid = JSON.stringify(config({real: '246813'}))

  it('round-trips a valid config', () => {
    expect(parseLockConfig(valid)?.verifiers).toHaveLength(1)
  })

  it('reads absent, malformed or wrong-version records as no lock rather than blocking boot', () => {
    // Failing open costs the PIN, never the seed — that stays enclave-gated.
    // Failing closed would strand a user out of their wallet over a bad blob.
    expect(parseLockConfig(null)).toBeUndefined()
    expect(parseLockConfig('not json')).toBeUndefined()
    expect(parseLockConfig(JSON.stringify({version: 1, mode: 'coldStart', verifiers: []}))).toBeUndefined()
    expect(parseLockConfig(JSON.stringify({version: 2, mode: 'nope', salt: SALT, verifiers: []}))).toBeUndefined()
  })

  it('rejects a config with no salt', () => {
    const noSalt = JSON.parse(valid) as Record<string, unknown>
    delete noSalt.salt
    expect(parseLockConfig(JSON.stringify(noSalt))).toBeUndefined()
  })

  it('rejects a config with no codes at all', () => {
    const empty = {...(JSON.parse(valid) as Record<string, unknown>), verifiers: []}
    expect(parseLockConfig(JSON.stringify(empty))).toBeUndefined()
  })

  it('accepts any non-empty set of codes, not only ones containing a real PIN', () => {
    const decoyOnly = {
      version: 2,
      mode: 'coldStart',
      salt: SALT,
      verifiers: [makeVerifier('decoy', '975310', SALT)],
    }
    const parsed = parseLockConfig(JSON.stringify(decoyOnly))
    expect(parsed?.verifiers[0]?.kind).toBe('decoy')
  })
})
