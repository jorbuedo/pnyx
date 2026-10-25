import {hkdfSha256} from '@pnyx/crypto'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {
  APP_SECRET_LENGTH,
  APP_SECRET_V1,
  appSecretInfo,
  appSecretSalt,
  MAX_APP_SECRET_DOMAIN,
  readAppSecretRequest,
} from './app-secret.js'

const refused = (result: ReturnType<typeof readAppSecretRequest>): boolean => !result.ok

describe('readAppSecretRequest', () => {
  it('reads a domain label', () => {
    const result = readAppSecretRequest(['names-deed:v1'])

    expect(result.ok && result.domain).toBe('names-deed:v1')
  })

  it('accepts a label at the length bound', () => {
    expect(refused(readAppSecretRequest(['a'.repeat(MAX_APP_SECRET_DOMAIN)]))).toBe(false)
  })

  describe('refusals', () => {
    it('refuses a missing or empty label rather than deriving a default secret', () => {
      // A default would be one secret shared by every site that forgot the argument.
      expect(refused(readAppSecretRequest([]))).toBe(true)
      expect(refused(readAppSecretRequest(['']))).toBe(true)
      expect(refused(readAppSecretRequest([42]))).toBe(true)
    })

    it('refuses a label past the bound', () => {
      expect(refused(readAppSecretRequest(['a'.repeat(MAX_APP_SECRET_DOMAIN + 1)]))).toBe(true)
    })

    it('refuses anything but printable ASCII', () => {
      // Unicode would raise "which normalisation?", and two labels that look identical must not
      // derive one secret.
      expect(refused(readAppSecretRequest(['déjà']))).toBe(true)
      expect(refused(readAppSecretRequest(['tab\there']))).toBe(true)
      expect(refused(readAppSecretRequest(['bell\u0007here']))).toBe(true)
    })
  })
})

describe('the derivation constants', () => {
  it('pins the v1 tag byte for byte', () => {
    // Compatibility *is* the specification here: a dApp's per-user secret has to survive the user
    // changing wallets, so these strings are shared with every other implementation. A change is a
    // v2 tag, never an edit — this test is what makes an edit fail.
    expect(APP_SECRET_V1).toBe('midnight:dapp-app-secret:v1')
    expect(new TextDecoder().decode(appSecretSalt())).toBe('midnight:dapp-app-secret:v1')
    expect(APP_SECRET_LENGTH).toBe(32)
  })

  it('folds origin and domain into info, in that order, pipe-separated', () => {
    expect(new TextDecoder().decode(appSecretInfo('https://dapp.example', 'names-deed:v1'))).toBe(
      'midnight:dapp-app-secret:v1|https://dapp.example|names-deed:v1',
    )
  })

  it('gives two sites different secrets from one key, and one site a stable one', async () => {
    const ikm = new Uint8Array(32).fill(7)
    const derive = (origin: string, domain: string) =>
      Effect.runPromise(hkdfSha256(ikm, appSecretInfo(origin, domain), APP_SECRET_LENGTH, appSecretSalt()))

    const a = await derive('https://a.example', 'deed:v1')
    const b = await derive('https://b.example', 'deed:v1')
    const aOther = await derive('https://a.example', 'other:v1')

    // Independent per site and per label — the point of folding both into `info`.
    expect(a).not.toEqual(b)
    expect(a).not.toEqual(aOther)
    // Deterministic: same inputs, same secret, which is what a dApp is relying on.
    expect(await derive('https://a.example', 'deed:v1')).toEqual(a)
    expect(a).toHaveLength(APP_SECRET_LENGTH)
  })
})
