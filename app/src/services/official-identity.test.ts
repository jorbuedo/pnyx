import {describe, expect, it} from 'vitest'
import {isOfficialIdentity, NO_OFFICIAL_IDENTITIES, readOfficialIdentities} from './official-identity'

// Real encodable ids, so the decode path is exercised rather than mocked away.
const {encodePnyxId} = await import('@pnyx/contract-client/identity')
const ID_A = encodePnyxId(new Uint8Array(32).fill(1))
const ID_B = encodePnyxId(new Uint8Array(32).fill(2))
const ID_C = encodePnyxId(new Uint8Array(32).fill(3))

describe('readOfficialIdentities', () => {
  it('reads nothing from an absent config', () => {
    expect(readOfficialIdentities(undefined)).toEqual(NO_OFFICIAL_IDENTITIES)
  })

  it('marks every readable id and records the support one', () => {
    const official = readOfficialIdentities({identities: [ID_A, ID_B], support: ID_A})
    expect(official.marked.has(ID_A)).toBe(true)
    expect(official.marked.has(ID_B)).toBe(true)
    expect(official.support).toBe(ID_A)
  })

  // ⚠️ A string in a config file is not an id. One that cannot be decoded must be dropped, not
  // carried into a comparison that would silently never match.
  it('drops an entry that is not a readable pnyx_id', () => {
    const official = readOfficialIdentities({identities: [ID_A, 'pnyx_id1nonsense', '', 'alice']})
    expect(official.marked.size).toBe(1)
    expect(official.marked.has(ID_A)).toBe(true)
  })

  it('drops an unreadable support id rather than keeping a broken target', () => {
    expect(readOfficialIdentities({identities: [ID_A], support: 'not-an-id'}).support).toBeUndefined()
  })

  // The alternative is a support conversation with no mark, which is the failure the mark exists for.
  it('marks the support id even when it was left out of the list', () => {
    const official = readOfficialIdentities({identities: [ID_A], support: ID_B})
    expect(official.support).toBe(ID_B)
    expect(official.marked.has(ID_B)).toBe(true)
  })
})

describe('isOfficialIdentity', () => {
  const official = readOfficialIdentities({identities: [ID_A]})

  it('recognises a listed id', () => {
    expect(isOfficialIdentity(ID_A, official)).toBe(true)
  })

  it('does not recognise an unlisted one', () => {
    expect(isOfficialIdentity(ID_C, official)).toBe(false)
  })

  it('is false for everything when nothing is configured', () => {
    expect(isOfficialIdentity(ID_A, NO_OFFICIAL_IDENTITIES)).toBe(false)
  })

  // A name can be anything; only the id decides. This is the whole point of keying on `C`.
  it('cannot be fooled by a subject that is not an id at all', () => {
    expect(isOfficialIdentity('Pnyx Support', official)).toBe(false)
  })
})
