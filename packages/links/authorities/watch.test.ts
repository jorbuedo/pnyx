import {Effect, Either} from 'effect'
import {describe, expect, it} from 'vitest'
import {build, parse} from './watch'

const read = (uri: string) => Effect.runSync(Effect.either(parse(new URL(uri))))

describe('watch authority', () => {
  it('reads an address and its optional name', () => {
    const result = read('web+cardano://watch/v1?address=addr1abc&name=Treasury')
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right).toEqual({authority: 'watch', version: 'v1', address: 'addr1abc', name: 'Treasury'})
    }
  })

  it('omits the name rather than carrying an empty one', () => {
    const result = read('web+cardano://watch/v1?address=stake1abc&name=%20%20')
    if (Either.isRight(result)) expect(result.right.name).toBeUndefined()
  })

  it('drops an implausibly long name but keeps the hand-off', () => {
    // The name is a convenience; refusing the whole link over a label would be the
    // wrong trade, and the import screen defaults it.
    const result = read(`web+cardano://watch/v1?address=addr1abc&name=${'n'.repeat(200)}`)
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.address).toBe('addr1abc')
      expect(result.right.name).toBeUndefined()
    }
  })

  it('refuses a link with no address, which would import nothing', () => {
    expect(Either.isLeft(read('web+cardano://watch/v1?name=Treasury'))).toBe(true)
  })

  it('refuses an unbounded address rather than passing a blob to the importer', () => {
    expect(Either.isLeft(read(`web+cardano://watch/v1?address=${'a'.repeat(300)}`))).toBe(true)
  })

  it('requires the version segment, so an unversioned link cannot be re-read later', () => {
    expect(Either.isLeft(read('web+cardano://watch?address=addr1abc'))).toBe(true)
    expect(Either.isLeft(read('web+cardano://watch/v2?address=addr1abc'))).toBe(true)
  })

  it('round-trips through build', () => {
    const uri = build('addr1abc', 'Treasury')
    const result = read(uri)
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right).toMatchObject({address: 'addr1abc', name: 'Treasury'})
    }
  })

  it('builds without a name when none is given', () => {
    expect(build('addr1abc')).toBe('web+cardano://watch/v1?address=addr1abc')
    expect(build('addr1abc', '   ')).toBe('web+cardano://watch/v1?address=addr1abc')
  })
})
