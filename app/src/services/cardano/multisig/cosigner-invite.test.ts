import {buildBrandLink} from '@pnyx/links'
import {Either} from 'effect'
import {describe, expect, it} from 'vitest'
import {buildCoSignerLink, readCoSignerKey} from './cosigner-invite'
import {encodeAccountXvk} from './shared-key'

const XPUB = 'ab'.repeat(64)
const bech32 = Either.getOrThrow(encodeAccountXvk(XPUB))
const right = <A>(e: Either.Either<A, unknown>): A => Either.getOrThrow(e)
const left = <E>(e: Either.Either<unknown, E>): E => {
  if (Either.isRight(e)) throw new Error('expected left')
  return e.left
}

describe('buildCoSignerLink', () => {
  it('builds an app-scheme link carrying the key', () => {
    const url = right(buildCoSignerLink(XPUB))
    expect(url.startsWith('pnyx://')).toBe(true)
    expect(url).toContain('acct_shared_xvk1')
  })

  it('carries nothing but the key — no name, no account index', () => {
    // A name proposed by the sender arrived pre-filled in the roster the builder
    // was meant to be checking, and the index labelled a key without binding it.
    const url = right(buildCoSignerLink(XPUB))
    expect(url).not.toContain('name=')
    expect(url).not.toContain('accountIndex=')
    expect([...new URL(url).searchParams.keys()]).toEqual(['key'])
  })

  it('can build the https fallback for someone without the app', () => {
    expect(right(buildCoSignerLink(XPUB, 'https')).startsWith('https://')).toBe(true)
  })

  it('refuses an xpub of the wrong length', () => {
    expect(left(buildCoSignerLink('aa'))).toEqual({kind: 'bad-key'})
  })
})

describe('readCoSignerKey', () => {
  it('round-trips a link', () => {
    expect(right(readCoSignerKey(right(buildCoSignerLink(XPUB))))).toBe(XPUB)
  })

  it('reads a bare acct_shared_xvk, which is what another wallet’s QR carries', () => {
    expect(right(readCoSignerKey(bech32))).toBe(XPUB)
  })

  it('tolerates whitespace around a scanned value', () => {
    expect(right(readCoSignerKey(` ${bech32}\n`))).toBe(XPUB)
  })

  it('still reads a link from an older build, ignoring its name and account index', () => {
    // Those builds are in people's hands; a key answered from one has to land.
    const legacy = buildBrandLink(
      {feature: 'multisig', useCase: 'cosigner-key', params: {key: bech32, name: 'Alice', accountIndex: 3}},
      'pnyx',
    )
    expect(right(readCoSignerKey(legacy))).toBe(XPUB)
  })

  it('refuses a link whose key will not decode', () => {
    const bogus = buildBrandLink(
      {feature: 'multisig', useCase: 'cosigner-key', params: {key: 'acct_shared_xvk1nope'}},
      'pnyx',
    )
    expect(left(readCoSignerKey(bogus))).toEqual({kind: 'bad-key'})
  })

  it('rejects a different brand link', () => {
    expect(left(readCoSignerKey('pnyx://pnyx.pxkq.uk/w1/browser/launch?dappUrl=x'))).toEqual({
      kind: 'not-a-cosigner-link',
    })
  })

  it('rejects prose and empty input', () => {
    expect(left(readCoSignerKey('hello'))).toEqual({kind: 'not-a-cosigner-link'})
    expect(left(readCoSignerKey(''))).toEqual({kind: 'not-a-cosigner-link'})
  })

  it('rejects a CIP-1852 spending key, which is not a co-signer key', () => {
    // The CIP-5 prefix is the only thing separating the two, and binding one into
    // a shared wallet would derive addresses nobody can spend from.
    expect(left(readCoSignerKey('acct_xvk1qqqqqqqqqq'))).toEqual({kind: 'not-a-cosigner-link'})
  })
})
