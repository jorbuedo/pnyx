import {describe, expect, it} from 'vitest'
import {createLogger} from './logger.js'
import {looksLikeMnemonic, REDACTED, redactLogMessage, redactMetadata} from './redact.js'
import type {LogTransportOptions} from './types.js'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('looksLikeMnemonic', () => {
  it.each([12, 15, 18, 21, 24])('accepts a %i-word phrase', (count) => {
    expect(looksLikeMnemonic(Array.from({length: count}, () => 'abandon').join(' '))).toBe(true)
  })

  it('accepts a real 12-word phrase', () => {
    expect(looksLikeMnemonic(MNEMONIC)).toBe(true)
  })

  it.each([11, 13, 16, 23, 25])('rejects a %i-word phrase (not a BIP-39 length)', (count) => {
    expect(looksLikeMnemonic(Array.from({length: count}, () => 'abandon').join(' '))).toBe(false)
  })

  // The false-positive guard that makes this safe to run over every log line:
  // prose is full of one- and two-letter words, and any capital or punctuation
  // rejects outright.
  it.each([
    ['prose with short words', 'the wallet could not be found on this device so we gave up now'],
    [
      'a capitalised sentence',
      'Abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    ],
    ['punctuation', 'abandon, abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'],
    [
      'a word over eight letters',
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon absolutely',
    ],
    ['transaction CBOR', 'a1b2c3d4e5f6a7b8c9d0'],
    ['an empty string', ''],
    ['a single word', 'abandon'],
  ])('rejects %s', (_label, value) => {
    expect(looksLikeMnemonic(value)).toBe(false)
  })
})

describe('redactMetadata', () => {
  it.each([
    'mnemonic',
    'walletMnemonic',
    'MNEMONIC',
    'recoveryPhrase',
    'recovery_phrase',
    'password',
    'passphrase',
    'seed',
    'entropy',
    'xprv',
    'stakeXprvHex',
    'privateKey',
    'private_key',
    'secretKey',
    'signingKey',
    'roleKey',
    'personaSk',
    'gateSecret',
    'ballotRand',
    'wif',
  ])('redacts by key name: %s', (key) => {
    expect(redactMetadata({[key]: 'whatever it was'})).toEqual({[key]: REDACTED})
  })

  it('redacts a mnemonic hiding under an innocuous key', () => {
    expect(redactMetadata({note: MNEMONIC})).toEqual({note: REDACTED})
  })

  // ⚠️ A boolean holds one bit — "was it there" — which is the whole point of a `hasX` field. The
  // key matches SECRET_KEY_PATTERN as a substring, so this used to come back `[redacted]` and took
  // the diagnostic with it: `preparing.tsx` could not tell a lost mnemonic from a failed creation.
  it('keeps a boolean even when the key names a secret', () => {
    expect(redactMetadata({hasMnemonic: false, hasSeed: true})).toEqual({hasMnemonic: false, hasSeed: true})
  })

  it('still redacts a non-boolean under the same key', () => {
    expect(redactMetadata({hasMnemonic: MNEMONIC})).toEqual({hasMnemonic: REDACTED})
    expect(redactMetadata({mnemonicCount: 12})).toEqual({mnemonicCount: REDACTED})
  })

  it('leaves the values this app debugs with intact', () => {
    const metadata = {
      origin: 'CardanoRail',
      groupId: 'group-1b3644dabddace8b5f6086eb264b609a',
      txHash: '8394018e46542e39147e88c717d4dfdaaca7bcd8182ebd2103456744e9ac5700',
      bodyHex: 'a300818258200f'.repeat(8),
      address: 'stake1u9cpdm6xl9e7397lq2vh340eceaalzdysrf5p7qhjajulwgexsql8',
      reason: 'submit rejected (400): ConwayMempoolFailure "All inputs are spent"',
      fee: 340_000,
      seeded: true,
    }
    expect(redactMetadata(metadata)).toEqual(metadata)
  })

  it('walks nested objects and arrays', () => {
    expect(redactMetadata({outer: {inner: {mnemonic: 'x'}}, legs: [{password: 'p'}, {ok: 'kept'}]})).toEqual({
      outer: {inner: {mnemonic: REDACTED}},
      legs: [{password: REDACTED}, {ok: 'kept'}],
    })
  })

  it('does not mutate the caller’s object', () => {
    const original = {mnemonic: MNEMONIC}
    redactMetadata(original)
    expect(original.mnemonic).toBe(MNEMONIC)
  })

  // Item 44 names error `cause` chains explicitly, and a VaultError riding as
  // `cause` is a real pattern here.
  it('redacts through an error cause chain', () => {
    const root = new Error(MNEMONIC)
    const wrapper = new Error('vault retrieve failed', {cause: root})
    const out = redactMetadata({error: wrapper}) as {error: {message: string; cause: {message: string}}}
    expect(out.error.message).toBe('vault retrieve failed')
    expect(out.error.cause.message).toBe(REDACTED)
  })

  it('survives a cyclic object instead of hanging', () => {
    const cyclic: Record<string, unknown> = {name: 'loop'}
    cyclic.self = cyclic
    expect(() => redactMetadata(cyclic)).not.toThrow()
    expect(JSON.stringify(redactMetadata(cyclic))).toContain('[truncated]')
  })
})

describe('redactLogMessage', () => {
  it('redacts a mnemonic passed as the message', () => {
    expect(redactLogMessage(MNEMONIC)).toBe(REDACTED)
  })

  it('keeps an ordinary message', () => {
    expect(redactLogMessage('wallet unlocked')).toBe('wallet unlocked')
  })

  // Transports special-case Error (stack capture, Sentry grouping), so the shape
  // has to survive redaction.
  it('keeps an Error an Error, scrubbing only its message', () => {
    const err = new Error(MNEMONIC)
    err.name = 'InvalidMnemonicError'
    const out = redactLogMessage(err)
    expect(out).toBeInstanceOf(Error)
    expect((out as Error).message).toBe(REDACTED)
    expect((out as Error).name).toBe('InvalidMnemonicError')
  })
})

/**
 * The enforcement item 44 actually asks for: not "is the redactor correct" but
 * "can a secret reach a transport". This fails if the chokepoint is ever moved,
 * bypassed, or removed.
 */
describe('no secret reaches a transport or the trail', () => {
  const capture = () => {
    const seen: LogTransportOptions[] = []
    const logger = createLogger({level: 'debug'})
    logger.addTransport((options) => seen.push(options))
    return {logger, seen}
  }

  it('scrubs metadata on the way to a transport', () => {
    const {logger, seen} = capture()
    logger.info('restoring wallet', {origin: 'Test', mnemonic: MNEMONIC})
    expect(seen[0]?.metadata).toEqual({origin: 'Test', mnemonic: REDACTED})
  })

  it('scrubs the trail too, because crash reports attach it', () => {
    const {logger} = capture()
    logger.warn('vault', {origin: 'Test', xprv: 'deadbeef'})
    expect(logger.trail[0]?.metadata).toEqual({origin: 'Test', xprv: REDACTED})
  })

  it('leaves no occurrence of the secret anywhere a transport can see', () => {
    const {logger, seen} = capture()
    logger.error(new Error('failed'), {
      origin: 'Test',
      mnemonic: MNEMONIC,
      nested: {seed: 'abc', note: MNEMONIC},
      innocuous: MNEMONIC,
    })
    const serialized = JSON.stringify(seen) + JSON.stringify(logger.trail)
    expect(serialized).not.toContain('abandon')
    expect(serialized).not.toContain('abc')
  })

  it('still delivers the diagnostic content around the secret', () => {
    const {logger, seen} = capture()
    logger.error(new Error('submit rejected (400): All inputs are spent'), {origin: 'Rail', mnemonic: MNEMONIC})
    expect((seen[0]?.message as Error).message).toBe('submit rejected (400): All inputs are spent')
    expect(seen[0]?.metadata.origin).toBe('Rail')
  })
})
