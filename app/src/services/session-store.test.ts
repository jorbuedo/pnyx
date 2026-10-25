import {beforeEach, describe, expect, it, vi} from 'vitest'

const store = new Map<string, string>()

vi.mock('../platform/storage', () => ({
  storage: {
    getSync: (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => void store.set(key, value),
    remove: async (key: string) => void store.delete(key),
  },
}))

import {clearStoredSession, restoreSessionSync, writeStoredSession} from './session-store'

const KEY = 'pnyx:session'
const MINUTE = 60_000
/** `iat`/`exp` an hour apart, which is what the service issues. */
const token = (iat = 1_700_000_000, exp = iat + 3600) =>
  `h.${Buffer.from(JSON.stringify({iat, exp})).toString('base64url')}.s`

const session = (receivedAtMs: number) => ({
  token: token(),
  network: 'preprod',
  identity: 'pnyx_id1xyz',
  receivedAtMs,
  forumRoot: new Uint8Array([1, 2, 3]),
})

beforeEach(() => {
  store.clear()
})

describe('writeStoredSession', () => {
  it('keeps the token but never the forum root', async () => {
    await writeStoredSession(session(1_000))

    const written = JSON.parse(store.get(KEY) as string) as Record<string, unknown>
    expect(written.token).toBe(token())
    expect(written.identity).toBe('pnyx_id1xyz')
    expect(written.receivedAtMs).toBe(1_000)
    // The whole security argument for persisting a token at all: the seed-derived half stays in memory.
    expect(written).not.toHaveProperty('forumRoot')
  })
})

describe('restoreSessionSync', () => {
  it('answers undefined when nothing was stored', () => {
    expect(restoreSessionSync()).toBeUndefined()
  })

  it('restores a token inside the window, with its lifetime read back from the claims', async () => {
    await writeStoredSession(session(10_000))

    const restored = restoreSessionSync(() => 10_000 + 5 * MINUTE)

    expect(restored?.token).toBe(token())
    expect(restored?.identity).toBe('pnyx_id1xyz')
    expect(restored?.lifetime).toEqual({issuedAtSecs: 1_700_000_000, expiresAtSecs: 1_700_003_600})
    // Nothing can put it back: it is not on disk and only the enclave can derive it again.
    expect(restored?.forumRoot).toBeUndefined()
  })

  it('discards a token past the window and clears it, so the next start does not re-read it', async () => {
    await writeStoredSession(session(10_000))

    expect(restoreSessionSync(() => 10_000 + 31 * MINUTE)).toBeUndefined()
    expect(store.has(KEY)).toBe(false)
  })

  it('treats an unparseable record as signed out', () => {
    store.set(KEY, 'not json')
    expect(restoreSessionSync()).toBeUndefined()
  })

  it('treats a record missing its timestamp as signed out, rather than assuming it is fresh', () => {
    store.set(KEY, JSON.stringify({token: token(), network: 'preprod', identity: 'pnyx_id1xyz'}))
    expect(restoreSessionSync()).toBeUndefined()
  })
})

describe('clearStoredSession', () => {
  it('removes the record', async () => {
    await writeStoredSession(session(1_000))
    await clearStoredSession()
    expect(store.has(KEY)).toBe(false)
  })
})
