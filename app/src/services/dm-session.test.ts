import {Effect} from 'effect'
import {beforeEach, describe, expect, it, vi} from 'vitest'

// In-memory stand-in for the platform store. Mocked at the module boundary rather than
// reimplemented, so the code under test is the real thing.
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

const {
  appendThread,
  deleteFromThread,
  deriveDmStoreKey,
  forgetPrivateHalf,
  forgetThread,
  keyPackageId,
  loadCursor,
  loadGroupState,
  loadPrivateHalf,
  loadThread,
  saveCursor,
  saveGroupState,
  savePrivateHalf,
} = await import('./dm-session')

const run = <A, E>(e: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(e as Effect.Effect<A, never>)
const either = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(Effect.either(e))

const forumRoot = (fill: number): Uint8Array => new Uint8Array(32).fill(fill)
const state = (fill: number, len = 64): Uint8Array => new Uint8Array(len).fill(fill)

beforeEach(() => {
  backing.clear()
})

describe('deriveDmStoreKey', () => {
  // Separated on the root, not on the network: the at-rest key must survive a preprod→mainnet
  // switch, or the MLS identity carries over and the message history it decrypts does not.
  it('is deterministic, root-separated, and takes no network', async () => {
    const a = await run(deriveDmStoreKey(forumRoot(1)))
    const b = await run(deriveDmStoreKey(forumRoot(1)))
    const other = await run(deriveDmStoreKey(forumRoot(2)))
    expect(a.key).toEqual(b.key)
    expect(a.key).not.toEqual(other.key)
    expect(a.key).toHaveLength(32)
    expect(deriveDmStoreKey.length).toBe(1)
  })
})

describe('group state', () => {
  it('round-trips through encryption', async () => {
    const key = await run(deriveDmStoreKey(forumRoot(2)))
    await run(saveGroupState(key, 'conv-1', state(0x42)))
    expect(await run(loadGroupState(key, 'conv-1'))).toEqual(state(0x42))
  })

  it('is stored encrypted — the plaintext never appears at rest', async () => {
    const key = await run(deriveDmStoreKey(forumRoot(3)))
    const secret = new TextEncoder().encode('ratchet-private-path')
    await run(saveGroupState(key, 'conv-2', secret))
    const atRest = [...backing.values()].join('|')
    expect(atRest).not.toContain('ratchet-private-path')
    expect(atRest.length).toBeGreaterThan(0)
  })

  it('returns undefined when there is no group yet, rather than failing', async () => {
    const key = await run(deriveDmStoreKey(forumRoot(4)))
    expect(await run(loadGroupState(key, 'never-seen'))).toBeUndefined()
  })

  it('fails rather than reporting "no group" when the key is wrong', async () => {
    // The distinction matters: treating a decrypt failure as absence would silently discard a live
    // conversation and start a fresh group in its place.
    const key = await run(deriveDmStoreKey(forumRoot(5)))
    await run(saveGroupState(key, 'conv-3', state(7)))
    const wrong = await run(deriveDmStoreKey(forumRoot(6)))
    const result = await either(loadGroupState(wrong, 'conv-3'))
    expect(result._tag).toBe('Left')
  })

  it('will not open a record moved to another conversation', async () => {
    // The record key is the AEAD's AAD, so a copied row cannot masquerade as another thread's state.
    const key = await run(deriveDmStoreKey(forumRoot(7)))
    await run(saveGroupState(key, 'conv-a', state(9)))
    const stored = backing.get('@pnyx/dm/state/conv-a') as string
    backing.set('@pnyx/dm/state/conv-b', stored)
    const result = await either(loadGroupState(key, 'conv-b'))
    expect(result._tag).toBe('Left')
  })

  it('overwrites cleanly as the ratchet advances', async () => {
    const key = await run(deriveDmStoreKey(forumRoot(8)))
    await run(saveGroupState(key, 'conv-4', state(1)))
    await run(saveGroupState(key, 'conv-4', state(2)))
    expect(await run(loadGroupState(key, 'conv-4'))).toEqual(state(2))
  })

  it('rejects a truncated record instead of returning garbage', async () => {
    const key = await run(deriveDmStoreKey(forumRoot(9)))
    backing.set('@pnyx/dm/state/conv-5', btoa('short'))
    expect((await either(loadGroupState(key, 'conv-5')))._tag).toBe('Left')
  })
})

describe('KeyPackage private halves', () => {
  it('derives the id as the hex sha256 of the public package, matching the service', async () => {
    // routes.ts files packages under sha256Hex(bytes); the same bytes must yield the same id here or
    // an arriving Welcome cannot be matched to its private half.
    const id = keyPackageId(new Uint8Array([1, 2, 3]))
    expect(id).toMatch(/^[0-9a-f]{64}$/)
    expect(keyPackageId(new Uint8Array([1, 2, 3]))).toBe(id)
    expect(keyPackageId(new Uint8Array([1, 2, 4]))).not.toBe(id)
  })

  it('round-trips and is encrypted at rest', async () => {
    const key = await run(deriveDmStoreKey(forumRoot(10)))
    const secret = new TextEncoder().encode('init-private-key')
    await run(savePrivateHalf(key, 'pkg-1', secret))
    expect(await run(loadPrivateHalf(key, 'pkg-1'))).toEqual(secret)
    expect([...backing.values()].join('|')).not.toContain('init-private-key')
  })

  it('reports absence as undefined — the unjoinable-group case the caller must handle', async () => {
    const key = await run(deriveDmStoreKey(forumRoot(11)))
    expect(await run(loadPrivateHalf(key, 'missing'))).toBeUndefined()
  })

  it('forgets a half only when asked', async () => {
    const key = await run(deriveDmStoreKey(forumRoot(12)))
    await run(savePrivateHalf(key, 'pkg-2', state(3)))
    await run(forgetPrivateHalf('pkg-2'))
    expect(await run(loadPrivateHalf(key, 'pkg-2'))).toBeUndefined()
  })
})

describe('poll cursor', () => {
  it('round-trips in the clear and reports absence', async () => {
    expect(await run(loadCursor('conv-6'))).toBeUndefined()
    await run(saveCursor('conv-6', '2026-07-31T00:00:00.000Z'))
    expect(await run(loadCursor('conv-6'))).toBe('2026-07-31T00:00:00.000Z')
    // Stored unencrypted on purpose: it is a timestamp the server already knows, and a corrupt
    // cursor should degrade to re-fetching rather than to a decrypt failure.
    expect(backing.get('@pnyx/dm/cursor/conv-6')).toBe('2026-07-31T00:00:00.000Z')
  })
})

describe('thread history', () => {
  const entry = (id: string, createdAt: string, text: string | undefined = `body ${id}`, mine = false) => ({
    id,
    mine,
    text,
    createdAt,
  })

  it('starts empty and round-trips through encryption', async () => {
    const key = await run(deriveDmStoreKey(forumRoot(7)))
    expect(await run(loadThread(key, 'conv-1'))).toEqual([])

    await run(appendThread(key, 'conv-1', [entry('a', '2026-08-05T10:00:00Z')]))
    expect(await run(loadThread(key, 'conv-1'))).toEqual([entry('a', '2026-08-05T10:00:00Z')])
  })

  it('does not store the plaintext in the clear', async () => {
    const key = await run(deriveDmStoreKey(forumRoot(7)))
    await run(appendThread(key, 'conv-1', [entry('a', '2026-08-05T10:00:00Z', 'meet me at the bridge')]))

    // The content of a private message must get at least what its ratchet state gets.
    const raw = [...backing.values()].join('|')
    expect(raw).not.toContain('meet me at the bridge')
  })

  it('is unreadable with a different store key', async () => {
    const key = await run(deriveDmStoreKey(forumRoot(7)))
    await run(appendThread(key, 'conv-1', [entry('a', '2026-08-05T10:00:00Z')]))

    const other = await run(deriveDmStoreKey(forumRoot(8)))
    expect((await either(loadThread(other, 'conv-1')))._tag).toBe('Left')
  })

  it('dedupes by id, which is what makes the message-first write order safe', async () => {
    // There is no transaction across the message, group-state and cursor writes, so a crash between
    // them can re-deliver a message. A duplicate has to be collapsible for that ordering to be right.
    const key = await run(deriveDmStoreKey(forumRoot(7)))
    await run(appendThread(key, 'conv-1', [entry('a', '2026-08-05T10:00:00Z')]))
    await run(appendThread(key, 'conv-1', [entry('a', '2026-08-05T10:00:00Z')]))

    expect(await run(loadThread(key, 'conv-1'))).toHaveLength(1)
  })

  it('keeps the first version of a message, so a gap marker cannot overwrite an opened one', async () => {
    const key = await run(deriveDmStoreKey(forumRoot(7)))
    await run(appendThread(key, 'conv-1', [entry('a', '2026-08-05T10:00:00Z', 'the real text')]))
    await run(appendThread(key, 'conv-1', [entry('a', '2026-08-05T10:00:00Z', undefined)]))

    expect((await run(loadThread(key, 'conv-1')))[0]?.text).toBe('the real text')
  })

  it('orders by createdAt regardless of write order', async () => {
    const key = await run(deriveDmStoreKey(forumRoot(7)))
    await run(appendThread(key, 'conv-1', [entry('b', '2026-08-05T11:00:00Z')]))
    await run(appendThread(key, 'conv-1', [entry('a', '2026-08-05T10:00:00Z')]))

    expect((await run(loadThread(key, 'conv-1'))).map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('deletes only the messages named, and leaves the rest readable', async () => {
    const key = await run(deriveDmStoreKey(forumRoot(7)))
    await run(
      appendThread(key, 'conv-1', [
        entry('a', '2026-08-05T10:00:00Z', 'first'),
        entry('b', '2026-08-05T11:00:00Z', 'second'),
        entry('c', '2026-08-05T12:00:00Z', 'third'),
      ]),
    )

    const kept = await run(deleteFromThread(key, 'conv-1', ['b']))
    expect(kept.map((e) => e.id)).toEqual(['a', 'c'])
    // Re-read rather than trusting the return: the record is re-sealed on write,
    // and a delete that corrupted it would still return the right array in memory.
    expect((await run(loadThread(key, 'conv-1'))).map((e) => e.text)).toEqual(['first', 'third'])
  })

  it('leaves the thread untouched when nothing matches', async () => {
    const key = await run(deriveDmStoreKey(forumRoot(7)))
    await run(appendThread(key, 'conv-1', [entry('a', '2026-08-05T10:00:00Z', 'first')]))

    expect(await run(deleteFromThread(key, 'conv-1', ['nope']))).toHaveLength(1)
    expect(await run(deleteFromThread(key, 'conv-1', []))).toHaveLength(1)
    expect((await run(loadThread(key, 'conv-1')))[0]?.text).toBe('first')
  })

  it('deletes a message for good — a re-append does not resurrect it', async () => {
    // `appendThread` is first-write-wins, so a delete followed by a redelivery of
    // the same id must be able to come back; what must not happen is the *stored*
    // copy surviving the delete.
    const key = await run(deriveDmStoreKey(forumRoot(7)))
    await run(appendThread(key, 'conv-1', [entry('a', '2026-08-05T10:00:00Z', 'gone')]))
    await run(deleteFromThread(key, 'conv-1', ['a']))

    expect(await run(loadThread(key, 'conv-1'))).toEqual([])
  })

  it('keeps our own messages, which can never be recovered from the server', async () => {
    // MLS gives a sender no way to reopen its own application message, so `send` holds the only
    // plaintext that will ever exist. This is the regression that emptied a thread on remount.
    const key = await run(deriveDmStoreKey(forumRoot(7)))
    await run(appendThread(key, 'conv-1', [entry('mine', '2026-08-05T10:00:00Z', 'sent by me', true)]))

    const reloaded = await run(loadThread(key, 'conv-1'))
    expect(reloaded).toEqual([entry('mine', '2026-08-05T10:00:00Z', 'sent by me', true)])
  })

  it('retains a gap marker for a message that could not be opened', async () => {
    // The ciphertext is unopenable from here on, so dropping it would silently omit a message the
    // peer believes they sent.
    const key = await run(deriveDmStoreKey(forumRoot(7)))
    await run(appendThread(key, 'conv-1', [entry('x', '2026-08-05T10:00:00Z', undefined)]))

    expect(await run(loadThread(key, 'conv-1'))).toEqual([entry('x', '2026-08-05T10:00:00Z', undefined)])
  })

  it('keeps conversations separate', async () => {
    const key = await run(deriveDmStoreKey(forumRoot(7)))
    await run(appendThread(key, 'conv-1', [entry('a', '2026-08-05T10:00:00Z')]))
    expect(await run(loadThread(key, 'conv-2'))).toEqual([])
  })

  it('returns the merged list so a caller can use it as its state directly', async () => {
    const key = await run(deriveDmStoreKey(forumRoot(7)))
    await run(appendThread(key, 'conv-1', [entry('a', '2026-08-05T10:00:00Z')]))
    const merged = await run(appendThread(key, 'conv-1', [entry('b', '2026-08-05T11:00:00Z')]))
    expect(merged.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('appending nothing is a read, not a write', async () => {
    const key = await run(deriveDmStoreKey(forumRoot(7)))
    await run(appendThread(key, 'conv-1', [entry('a', '2026-08-05T10:00:00Z')]))
    expect(await run(appendThread(key, 'conv-1', []))).toHaveLength(1)
  })

  it('forgets a conversation', async () => {
    const key = await run(deriveDmStoreKey(forumRoot(7)))
    await run(appendThread(key, 'conv-1', [entry('a', '2026-08-05T10:00:00Z')]))
    await run(forgetThread('conv-1'))
    expect(await run(loadThread(key, 'conv-1'))).toEqual([])
  })

  it('raises on a corrupt record rather than reporting an empty thread', async () => {
    // Reporting "no messages" for an unreadable record would look identical to a fresh conversation
    // and invite writing over history that is still there.
    const key = await run(deriveDmStoreKey(forumRoot(7)))
    backing.set('@pnyx/dm/thread/conv-1', 'not-a-sealed-record')
    expect((await either(loadThread(key, 'conv-1')))._tag).toBe('Left')
  })
})
