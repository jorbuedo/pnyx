import {Effect} from 'effect'
import {beforeEach, describe, expect, it, vi} from 'vitest'

// The platform boundary is the only thing mocked: the point of these tests is that every *store*
// a conversation lives in is actually emptied, so the stores themselves must be real.
const backing = new Map<string, string>()
vi.mock('../platform/storage', () => ({
  storage: {
    get: async (key: string) => backing.get(key) ?? null,
    set: async (key: string, value: string) => {
      backing.set(key, String(value))
    },
    remove: async (key: string) => {
      backing.delete(key)
    },
    getSync: (key: string) => backing.get(key) ?? null,
  },
}))

const {deleteDmConversation} = await import('./dm-delete')
const {
  appendThread,
  deriveDmStoreKey,
  loadConversationIndex,
  loadGroupState,
  loadThread,
  saveConversationIndex,
  saveGroupState,
} = await import('./dm-session')

const run = <A, E>(e: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(e as Effect.Effect<A, never>)

const ROOT = new Uint8Array(32).fill(7)
const CONV = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

/** A conversation as the app leaves it: group state, an index row, and a thread key on disk. */
const seed = async () => {
  const storeKey = await run(deriveDmStoreKey(ROOT))
  await run(saveGroupState(storeKey, CONV, new Uint8Array([1, 2, 3])))
  await run(saveGroupState(storeKey, OTHER, new Uint8Array([4, 5, 6])))
  await run(
    appendThread(storeKey, CONV, [{id: 'msg-1', mine: true, text: 'hello', createdAt: '2026-09-03T10:00:00.000Z'}]),
  )
  await run(
    saveConversationIndex(storeKey, [
      {convId: CONV, peer: 'peer-one', lastMessageAt: '2026-09-03T10:00:00.000Z'},
      {convId: OTHER, peer: 'peer-two', lastMessageAt: '2026-09-03T11:00:00.000Z'},
    ]),
  )
  return storeKey
}

describe('deleteDmConversation', () => {
  beforeEach(() => {
    backing.clear()
  })

  it('removes the group state, which is the part that makes a broken conversation permanent', async () => {
    // ⚠️ The reason this function exists. `startDmConversation` adopts existing group state instead
    // of rebuilding — so while the state survives, starting again silently hands back the very
    // conversation the user is trying to escape.
    const storeKey = await seed()

    const outcome = await deleteDmConversation(ROOT, CONV)

    expect(outcome).toEqual({ok: true, failed: []})
    expect(await run(loadGroupState(storeKey, CONV))).toBeUndefined()
  })

  it('removes the index row, so the inbox stops listing what can no longer be opened', async () => {
    const storeKey = await seed()

    await deleteDmConversation(ROOT, CONV)

    const index = await run(loadConversationIndex(storeKey))
    expect(index.map((one) => one.convId)).toEqual([OTHER])
  })

  it('leaves every other conversation alone', async () => {
    // A delete that took the neighbours with it would be a far worse bug than the one it fixes.
    const storeKey = await seed()

    await deleteDmConversation(ROOT, CONV)

    expect(await run(loadGroupState(storeKey, OTHER))).toBeDefined()
  })

  it('empties the stored thread', async () => {
    const storeKey = await seed()
    // Asserted non-empty first: the same expectation against a thread that was never written would
    // pass whether or not anything was deleted.
    expect(await run(loadThread(storeKey, CONV))).toHaveLength(1)

    await deleteDmConversation(ROOT, CONV)

    expect(await run(loadThread(storeKey, CONV))).toEqual([])
  })

  it('reports a partial delete rather than claiming success', async () => {
    // The outcome the caller must not mistake for a clean one: what survives decides whether
    // starting the conversation again will work, so "mostly deleted" has to be visible.
    await seed()
    const remove = vi.spyOn(await import('../platform/storage').then((m) => m.storage), 'remove')
    remove.mockRejectedValueOnce(new Error('storage is closed'))

    const outcome = await deleteDmConversation(ROOT, CONV)

    expect(outcome.ok).toBe(false)
    expect(outcome.failed).toContain('group')
    remove.mockRestore()
  })
})
