import {type DappSession, makeSessionManager, SESSION_MAX_AGE_MS, SessionStoreTag} from '@pnyx/dapp-connector'
import {createMemoryStorage} from '@pnyx/storage'
import {Effect, Layer} from 'effect'
import {describe, expect, it} from 'vitest'
import {loadSessions, makeStorageSessionStore, saveSessions} from './session-store'

const session = (over: Partial<DappSession> = {}): DappSession => ({
  id: 'session-1',
  origin: 'https://dapp.example',
  chainType: 'cardano',
  groupId: 'group-1',
  accountIndex: 0,
  connectedAt: Date.now(),
  expiresAt: Date.now() + SESSION_MAX_AGE_MS,
  ...over,
})

describe('storage session store', () => {
  it('round-trips sessions through save → load', async () => {
    const storage = createMemoryStorage()
    const sessions = [session(), session({id: 'session-2', origin: 'https://two.example'})]
    await Effect.runPromise(saveSessions(storage, sessions))
    const loaded = await Effect.runPromise(loadSessions(storage))
    expect(loaded).toEqual(sessions)
  })

  it('returns [] when unset and self-heals a corrupt blob', async () => {
    const storage = createMemoryStorage()
    expect(await Effect.runPromise(loadSessions(storage))).toEqual([])
    await Effect.runPromise(storage.set('dapp.sessions', '{not json'))
    expect(await Effect.runPromise(loadSessions(storage))).toEqual([])
  })

  it('drops rows of the wrong shape on load', async () => {
    const storage = createMemoryStorage()
    await Effect.runPromise(storage.set('dapp.sessions', JSON.stringify([session(), {id: 'bad'}, 42])))
    expect(await Effect.runPromise(loadSessions(storage))).toHaveLength(1)
  })

  it('isolates its key — unrelated keys are untouched', async () => {
    const storage = createMemoryStorage()
    await Effect.runPromise(storage.set('contacts.x', 'keep'))
    await Effect.runPromise(saveSessions(storage, [session()]))
    const keys = await Effect.runPromise(storage.keys())
    expect(keys).toContain('contacts.x')
    expect(keys).toContain('dapp.sessions')
    expect(await Effect.runPromise(storage.get('contacts.x'))).toBe('keep')
  })

  it('the manager hydrates persisted sessions and persists a new connect', async () => {
    const storage = createMemoryStorage()
    await Effect.runPromise(saveSessions(storage, [session()]))
    const store = makeStorageSessionStore(storage)
    const manager = await Effect.runPromise(
      makeSessionManager.pipe(Effect.provide(Layer.succeed(SessionStoreTag, store))),
    )
    expect(await Effect.runPromise(manager.isConnected('https://dapp.example', 'cardano', 'group-1', 0))).toBe(true)
    await Effect.runPromise(manager.connect('https://new.example', 'cardano', 'group-1', 0))
    // Persisted to storage so a fresh manager sees it.
    const reloaded = await Effect.runPromise(loadSessions(storage))
    expect(reloaded.some((s) => s.origin === 'https://new.example')).toBe(true)
  })

  it('gives a row saved before per-session expiry the legacy 24h lifetime', async () => {
    // Persisted by an older build: no expiresAt field at all.
    const storage = createMemoryStorage()
    const connectedAt = Date.now()
    await Effect.runPromise(
      storage.set(
        'dapp.sessions',
        JSON.stringify([
          {
            id: 'legacy',
            origin: 'https://dapp.example',
            chainType: 'cardano',
            groupId: 'g1',
            accountIndex: 0,
            connectedAt,
          },
        ]),
      ),
    )
    const loaded = await Effect.runPromise(loadSessions(storage))
    expect(loaded[0]?.expiresAt).toBe(connectedAt + SESSION_MAX_AGE_MS)
  })

  it('the manager prunes expired and search-engine-origin rows on hydrate', async () => {
    const storage = createMemoryStorage()
    await Effect.runPromise(
      saveSessions(storage, [
        session({id: 'fresh'}),
        session({id: 'stale', connectedAt: Date.now() - 25 * 60 * 60 * 1000, expiresAt: Date.now() - 1}),
        session({id: 'engine', origin: 'https://www.google.com'}),
      ]),
    )
    const store = makeStorageSessionStore(storage)
    const manager = await Effect.runPromise(
      makeSessionManager.pipe(Effect.provide(Layer.succeed(SessionStoreTag, store))),
    )
    const live = await Effect.runPromise(manager.sessions)
    expect(live.map((s) => s.id)).toEqual(['fresh'])
  })
})
