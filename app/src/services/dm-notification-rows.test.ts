import {describe, expect, it} from 'vitest'
import {planDmRows, type StoredRow, type UnreadConversation} from './dm-notification-rows'

const idFor = (convId: string): number => convId.length * 1000
const unread = (convId: string, label: string, lastMessageAt: string): UnreadConversation => ({
  convId,
  label,
  lastMessageAt,
})
const generic = (id: number): StoredRow => ({id, date: '2026-08-31T10:00:00.000Z', data: {kind: 'dm-message'}})
const ours = (id: number, convId: string, date: string, label = 'alice'): StoredRow => ({
  id,
  date,
  data: {kind: 'dm-message', dmConvId: convId, dmLabel: label},
})

describe('planDmRows', () => {
  it('replaces the generic push rows with one row per unread conversation', () => {
    // The reported symptom: three identical "New message" rows, none of which says who from.
    const plan = planDmRows(
      [generic(1), generic(2), generic(3)],
      [unread('abc', 'alice', '2026-08-31T11:00:00.000Z')],
      idFor,
    )
    expect(plan.remove).toEqual([1, 2, 3])
    expect(plan.upsert).toEqual([{id: idFor('abc'), convId: 'abc', date: '2026-08-31T11:00:00.000Z', label: 'alice'}])
  })

  it('plans nothing when the rows already match, so a recomputation is not a rewrite', () => {
    // This runs on every signal, socket open and resume; a plan that always wrote would churn.
    const rows = [ours(idFor('abc'), 'abc', '2026-08-31T11:00:00.000Z')]
    const plan = planDmRows(rows, [unread('abc', 'alice', '2026-08-31T11:00:00.000Z')], idFor)
    expect(plan).toEqual({remove: [], upsert: []})
  })

  it('re-dates a conversation when a newer message lands', () => {
    const rows = [ours(idFor('abc'), 'abc', '2026-08-31T11:00:00.000Z')]
    const plan = planDmRows(rows, [unread('abc', 'alice', '2026-08-31T11:05:00.000Z')], idFor)
    expect(plan.remove).toEqual([])
    expect(plan.upsert).toEqual([{id: idFor('abc'), convId: 'abc', date: '2026-08-31T11:05:00.000Z', label: 'alice'}])
  })

  it('removes our row once the conversation is read, so the centre agrees with the dot', () => {
    const rows = [ours(idFor('abc'), 'abc', '2026-08-31T11:00:00.000Z')]
    expect(planDmRows(rows, [], idFor)).toEqual({remove: [idFor('abc')], upsert: []})
  })

  it('leaves rows that are not about DMs alone', () => {
    const other: StoredRow = {id: 9, date: '2026-08-31T10:00:00.000Z', data: {kind: 'post-reply'}}
    const plan = planDmRows([other], [], idFor)
    expect(plan.remove).toEqual([])
    expect(plan.upsert).toEqual([])
  })

  it('handles several unread conversations at once', () => {
    const plan = planDmRows(
      [generic(1)],
      [unread('a', 'alice', '2026-08-31T11:00:00.000Z'), unread('bb', 'bob', '2026-08-31T11:01:00.000Z')],
      idFor,
    )
    expect(plan.remove).toEqual([1])
    expect(plan.upsert.map((u) => u.convId)).toEqual(['a', 'bb'])
  })

  it('treats an invite push as generic too', () => {
    const invite: StoredRow = {id: 4, date: '2026-08-31T10:00:00.000Z', data: {kind: 'dm-invite'}}
    expect(planDmRows([invite], [], idFor).remove).toEqual([4])
  })

  it('rewrites the row when a handle resolves after it was written', () => {
    // The peer's name arrives from a chain read, so the first row often carries the shortened id.
    // On date alone it would keep that id for the life of the conversation.
    const rows = [ours(idFor('abc'), 'abc', '2026-08-31T11:00:00.000Z', 'pnyx_id1dc…726l')]
    const plan = planDmRows(rows, [unread('abc', 'alice', '2026-08-31T11:00:00.000Z')], idFor)
    expect(plan.remove).toEqual([])
    expect(plan.upsert).toEqual([{id: idFor('abc'), convId: 'abc', date: '2026-08-31T11:00:00.000Z', label: 'alice'}])
  })
})
