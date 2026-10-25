import {describe, expect, it} from 'vitest'
import {listedConversations, searchedConversations} from './inbox-rows'

const SELF = 'pnyx_id1self'
const PEER = 'pnyx_id1peer'

describe('listedConversations', () => {
  it('drops the self-conversation, which the anchored row already offers', () => {
    const listed = listedConversations([{peer: SELF}, {peer: PEER}], SELF)
    expect(listed).toEqual([{peer: PEER}])
  })

  it('keeps every peer conversation, and their order', () => {
    const other = 'pnyx_id1other'
    expect(listedConversations([{peer: PEER}, {peer: other}], SELF)).toEqual([{peer: PEER}, {peer: other}])
  })

  it('changes nothing when the self-conversation has not been started', () => {
    expect(listedConversations([{peer: PEER}], SELF)).toEqual([{peer: PEER}])
  })

  it('leaves the whole list when no identity matches — never guesses which row is ours', () => {
    expect(listedConversations([{peer: PEER}], 'pnyx_id1someoneelse')).toHaveLength(1)
  })
})

describe('searchedConversations', () => {
  const ALICE = 'pnyx_id1alice00000000000000000000000000000000000000000000000000000'
  const BOB = 'pnyx_id1bob0000000000000000000000000000000000000000000000000000000'
  const rows = [{peer: ALICE}, {peer: BOB}]
  const handles: ReadonlyMap<string, string> = new Map([[ALICE, 'Alice']])

  it('leaves the list alone for an empty or whitespace query', () => {
    expect(searchedConversations(rows, '', handles)).toEqual(rows)
    expect(searchedConversations(rows, '   ', handles)).toEqual(rows)
  })

  it('matches a known handle regardless of case', () => {
    expect(searchedConversations(rows, 'alice', handles)).toEqual([{peer: ALICE}])
    expect(searchedConversations(rows, 'ALI', handles)).toEqual([{peer: ALICE}])
  })

  it('matches the id even for a peer already drawn under a handle', () => {
    // Someone pasting an id they were handed must find the row, whatever label is on screen.
    expect(searchedConversations(rows, 'id1alice', handles)).toEqual([{peer: ALICE}])
  })

  it('finds a peer whose handle has not resolved, by id', () => {
    expect(searchedConversations(rows, 'id1bob', handles)).toEqual([{peer: BOB}])
  })

  it('matches a decomposed spelling of the name on screen', () => {
    const jose = 'pnyx_id1jose0000000000000000000000000000000000000000000000000000000'
    // Precomposed U+00E9 in the handle, as the row is drawn...
    const withNfc: ReadonlyMap<string, string> = new Map([[jose, 'Jos\u00e9']])
    // ...against a query typed as `e` + combining acute U+0301, which an IME or a paste from
    // another app produces. Written as escapes on purpose: the two spellings are visually identical,
    // so as literal characters an editor or a formatter could normalise the difference away.
    expect(searchedConversations([{peer: jose}], 'jose\u0301', withNfc)).toEqual([{peer: jose}])
  })

  it('returns nothing when neither the handle nor the id matches', () => {
    expect(searchedConversations(rows, 'carol', handles)).toEqual([])
  })
})
