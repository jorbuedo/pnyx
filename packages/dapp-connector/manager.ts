/**
 * dApp session manager. A session authorizes one (origin, chainType, wallet
 * group, account) tuple; the same dApp can be connected to several
 * groups/accounts independently. The account is part of the identity because a
 * grant exposes *that* account's addresses — switching accounts must not silently
 * hand a dApp a different one. Each session carries its own expiry — the user chooses how long
 * a connection lasts at approval time — and expired ones are pruned on read.
 * Persistence goes through the app-provided {@link SessionStoreTag} port.
 *
 * @module
 */

import {Clock, Context, Data, Effect, Layer, Ref} from 'effect'
import {type ChainType, isChainType} from './types.js'

export type DappSession = {
  readonly id: string
  readonly origin: string
  readonly chainType: ChainType
  readonly groupId: string
  /** Which derived account of the group the grant exposes. */
  readonly accountIndex: number
  readonly connectedAt: number
  /** When the grant lapses; `null` means it lasts until the user revokes it. */
  readonly expiresAt: number | null
}

/** Default grant lifetime when a caller doesn't choose one. */
export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** The lifetime pre-selected in the approval UI. */
export const DEFAULT_SESSION_TTL_MS: number = 7 * 24 * 60 * 60 * 1000

/**
 * Validate a persisted row, the single shape check for every store.
 *
 * A row predating per-session expiry gets the legacy 24h lifetime derived from
 * `connectedAt` — that is not a guess, it is exactly what the old code applied.
 * A row predating account scoping is *dropped*: the account it authorized was
 * never recorded, and inventing one would silently grant access to an account the
 * user never approved. The dApp simply re-prompts.
 */
export const parseDappSession = (value: unknown): DappSession | null => {
  if (typeof value !== 'object' || value === null) return null
  const s = value as Record<string, unknown>
  if (
    typeof s.id !== 'string' ||
    typeof s.origin !== 'string' ||
    !isChainType(s.chainType) ||
    typeof s.groupId !== 'string' ||
    typeof s.accountIndex !== 'number' ||
    typeof s.connectedAt !== 'number'
  ) {
    return null
  }
  const expiresAt =
    s.expiresAt === null ? null : typeof s.expiresAt === 'number' ? s.expiresAt : s.connectedAt + SESSION_MAX_AGE_MS
  return {
    id: s.id,
    origin: s.origin,
    chainType: s.chainType,
    groupId: s.groupId,
    accountIndex: s.accountIndex,
    connectedAt: s.connectedAt,
    expiresAt,
  }
}

/** Whether a grant has lapsed. A `null` expiry never does. */
export const isSessionExpired = (session: DappSession, now: number): boolean =>
  session.expiresAt !== null && now > session.expiresAt

export class SessionStoreError extends Data.TaggedError('SessionStoreError')<{
  readonly reason: string
  readonly cause?: unknown
}> {}

/** Persistence port — the app provides an MMKV/secure-storage-backed layer. */
export type SessionStore = {
  readonly load: Effect.Effect<readonly DappSession[], SessionStoreError>
  readonly save: (sessions: readonly DappSession[]) => Effect.Effect<void, SessionStoreError>
}

export class SessionStoreTag extends Context.Tag('@pnyx/dapp-connector/SessionStore')<
  SessionStoreTag,
  SessionStore
>() {}

/**
 * Volatile store instance — tests and previews. Each call owns its own state, so
 * hold onto the instance when the state has to outlive a single manager (the
 * manager may be rebuilt per operation to stay read-through).
 */
export const makeInMemorySessionStore = (): SessionStore => {
  let sessions: readonly DappSession[] = []
  return {
    load: Effect.sync(() => sessions),
    save: (next) =>
      Effect.sync(() => {
        sessions = next
      }),
  }
}

/** Volatile store — tests and previews. */
export const InMemorySessionStore: Layer.Layer<SessionStoreTag> = Layer.sync(SessionStoreTag, makeInMemorySessionStore)

/**
 * Normalize a page origin/URL for session keying: lowercase scheme + host,
 * default ports stripped. Throws on unparseable input.
 */
export const normalizeOrigin = (originOrUrl: string): string => {
  const url = new URL(originOrUrl)
  const scheme = url.protocol.toLowerCase()
  const host = url.hostname.toLowerCase()
  const port =
    url.port === '' || (scheme === 'https:' && url.port === '443') || (scheme === 'http:' && url.port === '80')
      ? ''
      : `:${url.port}`
  return `${scheme}//${host}${port}`
}

/**
 * Hosts that are search engines, not dApps. A legacy mobile-browser race keyed
 * sessions by the WebView's last navigation URL instead of the message origin,
 * capturing the search page the user came from — such rows are invalid and
 * self-heal on load. Dot-boundary suffix matching (subdomains match, lookalike
 * registrable domains don't).
 */
const SEARCH_ENGINE_DOMAINS: readonly string[] = [
  'google.com',
  'bing.com',
  'duckduckgo.com',
  'yahoo.com',
  'yahoo.co.jp',
  'naver.com',
  'yandex.com',
  'yandex.ru',
  'baidu.com',
  'ecosia.org',
  'brave.com',
  'startpage.com',
  'qwant.com',
]

export const isInvalidSessionOrigin = (origin: string): boolean => {
  if (!origin || origin === 'unknown') return true
  let host: string
  try {
    host = new URL(origin).hostname.toLowerCase()
  } catch {
    return true
  }
  return SEARCH_ENGINE_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

export type SessionManager = {
  readonly sessions: Effect.Effect<readonly DappSession[], SessionStoreError>
  readonly getSession: (
    origin: string,
    chainType: ChainType,
    groupId: string,
    accountIndex: number,
  ) => Effect.Effect<DappSession | undefined, SessionStoreError>
  readonly sessionsForOrigin: (
    origin: string,
    chainType: ChainType,
  ) => Effect.Effect<readonly DappSession[], SessionStoreError>
  /**
   * True when the origin has a live session for the chain. Narrows by group when
   * `groupId` is given, and by account when `accountIndex` is too; omitting either
   * means "any".
   */
  readonly isConnected: (
    origin: string,
    chainType: ChainType,
    groupId?: string,
    accountIndex?: number,
  ) => Effect.Effect<boolean, SessionStoreError>
  /**
   * Create + persist a session for the origin (normalized) and group.
   * `ttlMs` is how long the grant lasts: omit for {@link SESSION_MAX_AGE_MS},
   * or pass `null` to keep it until the user revokes it.
   */
  readonly connect: (
    origin: string,
    chainType: ChainType,
    groupId: string,
    accountIndex: number,
    ttlMs?: number | null,
  ) => Effect.Effect<DappSession, SessionStoreError>
  readonly disconnect: (
    origin: string,
    chainType: ChainType,
    groupId: string,
    accountIndex: number,
  ) => Effect.Effect<void, SessionStoreError>
  readonly clear: Effect.Effect<void, SessionStoreError>
}

const sessionKey = (origin: string, chainType: ChainType, groupId: string, accountIndex: number): string =>
  `${origin}:${chainType}:${groupId}:${accountIndex}`

let sessionCounter = 0

/**
 * Build the manager: hydrates from the store (dropping expired and invalid
 * origins), keeps state in a Ref, persists on every mutation.
 */
export const makeSessionManager: Effect.Effect<SessionManager, SessionStoreError, SessionStoreTag> = Effect.gen(
  function* () {
    const store = yield* SessionStoreTag
    const now = Clock.currentTimeMillis
    const stored = yield* store.load
    const initialNow = yield* now
    const live = new Map<string, DappSession>()
    for (const session of stored) {
      if (isSessionExpired(session, initialNow)) continue
      if (isInvalidSessionOrigin(session.origin)) continue
      live.set(sessionKey(session.origin, session.chainType, session.groupId, session.accountIndex), session)
    }
    const state = yield* Ref.make<ReadonlyMap<string, DappSession>>(live)

    const persist = Effect.flatMap(Ref.get(state), (map) => store.save([...map.values()]))

    const pruneExpired = Effect.gen(function* () {
      const timestamp = yield* now
      const map = yield* Ref.get(state)
      let changed = false
      const next = new Map(map)
      for (const [key, session] of map) {
        if (isSessionExpired(session, timestamp)) {
          next.delete(key)
          changed = true
        }
      }
      if (changed) {
        yield* Ref.set(state, next)
        yield* persist
      }
      return next
    })

    const sessions = Effect.map(pruneExpired, (map) => [...map.values()])

    return {
      sessions,
      getSession: (origin, chainType, groupId, accountIndex) =>
        Effect.map(pruneExpired, (map) =>
          map.get(sessionKey(normalizeOrigin(origin), chainType, groupId, accountIndex)),
        ),
      sessionsForOrigin: (origin, chainType) =>
        Effect.map(pruneExpired, (map) => {
          const normalized = normalizeOrigin(origin)
          return [...map.values()].filter((s) => s.origin === normalized && s.chainType === chainType)
        }),
      isConnected: (origin, chainType, groupId, accountIndex) =>
        Effect.map(pruneExpired, (map) => {
          const normalized = normalizeOrigin(origin)
          if (groupId !== undefined && accountIndex !== undefined) {
            return map.has(sessionKey(normalized, chainType, groupId, accountIndex))
          }
          return [...map.values()].some(
            (s) =>
              s.origin === normalized && s.chainType === chainType && (groupId === undefined || s.groupId === groupId),
          )
        }),
      connect: (origin, chainType, groupId, accountIndex, ttlMs = SESSION_MAX_AGE_MS) =>
        Effect.gen(function* () {
          const normalized = normalizeOrigin(origin)
          const timestamp = yield* now
          sessionCounter += 1
          const session: DappSession = {
            id: `session-${timestamp.toString(36)}-${sessionCounter.toString(36)}`,
            origin: normalized,
            chainType,
            groupId,
            accountIndex,
            connectedAt: timestamp,
            expiresAt: ttlMs === null ? null : timestamp + ttlMs,
          }
          yield* Ref.update(state, (map) => {
            const next = new Map(map)
            next.set(sessionKey(normalized, chainType, groupId, accountIndex), session)
            return next
          })
          yield* persist
          return session
        }),
      disconnect: (origin, chainType, groupId, accountIndex) =>
        Effect.gen(function* () {
          yield* Ref.update(state, (map) => {
            const next = new Map(map)
            next.delete(sessionKey(normalizeOrigin(origin), chainType, groupId, accountIndex))
            return next
          })
          yield* persist
        }),
      clear: Effect.zipRight(Ref.set(state, new Map()), persist),
    } satisfies SessionManager
  },
)
