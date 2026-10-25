import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {
  type DappSession,
  InMemorySessionStore,
  isInvalidSessionOrigin,
  isSessionExpired,
  makeSessionManager,
  normalizeOrigin,
  parseDappSession,
  SESSION_MAX_AGE_MS,
  type SessionStore,
  SessionStoreTag,
} from './manager.js'

const withManager = <A>(f: (manager: Awaited<ReturnType<typeof runManager>>) => Promise<A>): Promise<A> =>
  runManager().then(f)

const runManager = (store?: SessionStore) =>
  Effect.runPromise(
    store
      ? Effect.provideService(makeSessionManager, SessionStoreTag, store)
      : Effect.provide(makeSessionManager, InMemorySessionStore),
  )

describe('normalizeOrigin', () => {
  it('lowercases and strips default ports', () => {
    expect(normalizeOrigin('HTTPS://DApp.Example:443/path?q=1')).toBe('https://dapp.example')
    expect(normalizeOrigin('http://dapp.example:80')).toBe('http://dapp.example')
  })

  it('keeps non-default ports', () => {
    expect(normalizeOrigin('http://localhost:8081')).toBe('http://localhost:8081')
  })

  it('throws on garbage', () => {
    expect(() => normalizeOrigin('not a url')).toThrow()
  })
})

describe('isInvalidSessionOrigin', () => {
  it('rejects search engines and their subdomains', () => {
    expect(isInvalidSessionOrigin('https://www.google.com')).toBe(true)
    expect(isInvalidSessionOrigin('https://search.yahoo.co.jp')).toBe(true)
  })

  it('does not reject lookalike registrable domains', () => {
    expect(isInvalidSessionOrigin('https://mygoogle.com.attacker.io')).toBe(false)
  })

  it('rejects empty / unknown / malformed', () => {
    expect(isInvalidSessionOrigin('')).toBe(true)
    expect(isInvalidSessionOrigin('unknown')).toBe(true)
    expect(isInvalidSessionOrigin('::')).toBe(true)
  })

  it('accepts a real dApp origin', () => {
    expect(isInvalidSessionOrigin('https://app.minswap.org')).toBe(false)
  })
})

describe('makeSessionManager', () => {
  it('connect → isConnected → disconnect round-trip with origin normalization', async () => {
    await withManager(async (manager) => {
      const session = await Effect.runPromise(manager.connect('HTTPS://DApp.Example:443', 'cardano', 'g1', 0))
      expect(session.origin).toBe('https://dapp.example')
      expect(await Effect.runPromise(manager.isConnected('https://dapp.example', 'cardano'))).toBe(true)
      expect(await Effect.runPromise(manager.isConnected('https://dapp.example', 'cardano', 'g1'))).toBe(true)
      expect(await Effect.runPromise(manager.isConnected('https://dapp.example', 'cardano', 'g2'))).toBe(false)
      await Effect.runPromise(manager.disconnect('https://dapp.example', 'cardano', 'g1', 0))
      expect(await Effect.runPromise(manager.isConnected('https://dapp.example', 'cardano'))).toBe(false)
    })
  })

  it('sessions are per-group', async () => {
    await withManager(async (manager) => {
      await Effect.runPromise(manager.connect('https://dapp.example', 'cardano', 'g1', 0))
      await Effect.runPromise(manager.connect('https://dapp.example', 'cardano', 'g2', 0))
      const forOrigin = await Effect.runPromise(manager.sessionsForOrigin('https://dapp.example', 'cardano'))
      expect(forOrigin.map((s) => s.groupId).sort()).toEqual(['g1', 'g2'])
    })
  })

  it('drops expired and invalid-origin sessions on hydration', async () => {
    const expired: DappSession = {
      id: 's1',
      origin: 'https://dapp.example',
      chainType: 'cardano',
      groupId: 'g1',
      accountIndex: 0,
      connectedAt: Date.now() - SESSION_MAX_AGE_MS - 1,
      expiresAt: Date.now() - 1,
    }
    const searchEngine: DappSession = {
      ...expired,
      id: 's2',
      origin: 'https://www.google.com',
      connectedAt: Date.now(),
      expiresAt: Date.now() + SESSION_MAX_AGE_MS,
    }
    const fresh: DappSession = {...searchEngine, id: 's3', origin: 'https://dapp.example'}
    const manager = await runManager({
      load: Effect.succeed([expired, searchEngine, fresh]),
      save: () => Effect.void,
    })
    const sessions = await Effect.runPromise(manager.sessions)
    expect(sessions.map((s) => s.id)).toEqual(['s3'])
  })

  it('prunes sessions that expire after hydration and persists the prune', async () => {
    const stale: DappSession = {
      id: 's1',
      origin: 'https://dapp.example',
      chainType: 'cardano',
      groupId: 'g1',
      accountIndex: 0,
      connectedAt: Date.now() - SESSION_MAX_AGE_MS + 5,
      // expires between hydration and the read below
      expiresAt: Date.now() + 5,
    }
    const saved: (readonly DappSession[])[] = []
    const manager = await runManager({
      load: Effect.succeed([stale]),
      save: (sessions) =>
        Effect.sync(() => {
          saved.push(sessions)
        }),
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await Effect.runPromise(manager.isConnected('https://dapp.example', 'cardano'))).toBe(false)
    expect(saved.at(-1)).toEqual([])
  })

  it('persists on connect', async () => {
    const saved: (readonly DappSession[])[] = []
    const manager = await runManager({
      load: Effect.succeed([]),
      save: (sessions) =>
        Effect.sync(() => {
          saved.push(sessions)
        }),
    })
    await Effect.runPromise(manager.connect('https://dapp.example', 'cardano', 'g1', 0))
    expect(saved.at(-1)?.map((s) => s.groupId)).toEqual(['g1'])
  })

  describe('per-session expiry', () => {
    it('defaults to the 24h lifetime when no ttl is given', async () => {
      const manager = await runManager({load: Effect.succeed([]), save: () => Effect.void})
      const before = Date.now()
      const session = await Effect.runPromise(manager.connect('https://dapp.example', 'cardano', 'g1', 0))
      expect(session.expiresAt).not.toBeNull()
      expect(session.expiresAt as number).toBeGreaterThanOrEqual(before + SESSION_MAX_AGE_MS)
    })

    it('honours a chosen lifetime', async () => {
      const manager = await runManager({load: Effect.succeed([]), save: () => Effect.void})
      const week = 7 * 24 * 60 * 60 * 1000
      const before = Date.now()
      const session = await Effect.runPromise(manager.connect('https://dapp.example', 'cardano', 'g1', 0, week))
      expect(session.expiresAt as number).toBeGreaterThanOrEqual(before + week)
    })

    it('keeps a null-ttl grant forever', async () => {
      const manager = await runManager({load: Effect.succeed([]), save: () => Effect.void})
      const session = await Effect.runPromise(manager.connect('https://dapp.example', 'cardano', 'g1', 0, null))
      expect(session.expiresAt).toBeNull()
      expect(isSessionExpired(session, Date.now() + 10 * 365 * 24 * 60 * 60 * 1000)).toBe(false)
    })

    it('prunes by each row own expiry, not a global age', async () => {
      // A grant older than 24h survives when its chosen lifetime is longer.
      const old: DappSession = {
        id: 's1',
        origin: 'https://dapp.example',
        chainType: 'cardano',
        groupId: 'g1',
        accountIndex: 0,
        connectedAt: Date.now() - 3 * SESSION_MAX_AGE_MS,
        expiresAt: Date.now() + SESSION_MAX_AGE_MS,
      }
      const manager = await runManager({load: Effect.succeed([old]), save: () => Effect.void})
      expect(await Effect.runPromise(manager.isConnected('https://dapp.example', 'cardano'))).toBe(true)
    })
  })
})

describe('parseDappSession', () => {
  it('derives the legacy 24h expiry for a row saved before per-session ttls', () => {
    const connectedAt = 1_700_000_000_000
    const parsed = parseDappSession({
      id: 's1',
      origin: 'https://d.example',
      chainType: 'cardano',
      groupId: 'g1',
      accountIndex: 0,
      connectedAt,
    })
    expect(parsed?.expiresAt).toBe(connectedAt + SESSION_MAX_AGE_MS)
  })

  it('preserves an explicit null expiry', () => {
    const parsed = parseDappSession({
      id: 's1',
      origin: 'https://d.example',
      chainType: 'cardano',
      groupId: 'g1',
      accountIndex: 0,
      connectedAt: 1,
      expiresAt: null,
    })
    expect(parsed?.expiresAt).toBeNull()
  })

  it('rejects a malformed row', () => {
    expect(parseDappSession({id: 's1'})).toBeNull()
    expect(parseDappSession(null)).toBeNull()
    expect(
      parseDappSession({id: 's1', origin: 'x', chainType: 'bogus', groupId: 'g', accountIndex: 0, connectedAt: 1}),
    ).toBeNull()
    // A row predating account scoping is dropped, not given a guessed account.
    expect(parseDappSession({id: 's1', origin: 'x', chainType: 'cardano', groupId: 'g', connectedAt: 1})).toBeNull()
  })
})
