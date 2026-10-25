import {makeInMemorySessionStore, SESSION_MAX_AGE_MS, type SessionStore} from '@pnyx/dapp-connector'
import {Effect} from 'effect'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {makeSessionPort} from './session-port'

const ORIGIN = 'https://dapp.example'
const GROUP = 'group-1'
const ACCOUNT = 0
const run = <A>(effect: Effect.Effect<A>): Promise<A> => Effect.runPromise(effect)

afterEach(() => {
  vi.useRealTimers()
})

describe('makeSessionPort', () => {
  it('reports an origin connected only after connect', async () => {
    const port = makeSessionPort(makeInMemorySessionStore())
    expect(await run(port.isConnected(ORIGIN, GROUP, ACCOUNT))).toBe(false)
    await run(port.connect(ORIGIN, GROUP, ACCOUNT, SESSION_MAX_AGE_MS))
    expect(await run(port.isConnected(ORIGIN, GROUP, ACCOUNT))).toBe(true)
  })

  it('scopes a grant to its wallet group', async () => {
    const port = makeSessionPort(makeInMemorySessionStore())
    await run(port.connect(ORIGIN, GROUP, ACCOUNT, SESSION_MAX_AGE_MS))
    expect(await run(port.isConnected(ORIGIN, 'group-2', ACCOUNT))).toBe(false)
    // Omitting the group asks "connected to anything?".
    expect(await run(port.isConnected(ORIGIN))).toBe(true)
  })

  it('scopes a grant to its account, so a sibling account is not connected', async () => {
    const port = makeSessionPort(makeInMemorySessionStore())
    await run(port.connect(ORIGIN, GROUP, 0, SESSION_MAX_AGE_MS))
    expect(await run(port.isConnected(ORIGIN, GROUP, 1))).toBe(false)
    expect(await run(port.isConnected(ORIGIN, GROUP, 0))).toBe(true)
  })

  it('normalizes the origin, so a default port and casing reuse one grant', async () => {
    const port = makeSessionPort(makeInMemorySessionStore())
    await run(port.connect('https://DApp.example:443', GROUP, ACCOUNT, SESSION_MAX_AGE_MS))
    expect(await run(port.isConnected(ORIGIN, GROUP, ACCOUNT))).toBe(true)
  })

  it('keeps state across calls even though the manager is rebuilt each time', async () => {
    // Regression guard: a per-call layer build would hand every call its own store.
    const store = makeInMemorySessionStore()
    const port = makeSessionPort(store)
    await run(port.connect(ORIGIN, GROUP, ACCOUNT, SESSION_MAX_AGE_MS))
    expect(await run(port.isConnected(ORIGIN, GROUP, ACCOUNT))).toBe(true)
    expect(await Effect.runPromise(store.load)).toHaveLength(1)
  })

  it('sees a revoke performed directly against the store', async () => {
    // This read-through behaviour is what lets the app mutate sessions itself.
    const store = makeInMemorySessionStore()
    const port = makeSessionPort(store)
    await run(port.connect(ORIGIN, GROUP, ACCOUNT, SESSION_MAX_AGE_MS))
    await Effect.runPromise(store.save([]))
    expect(await run(port.isConnected(ORIGIN, GROUP, ACCOUNT))).toBe(false)
  })

  it('expires a grant once the TTL elapses', async () => {
    vi.useFakeTimers()
    const port = makeSessionPort(makeInMemorySessionStore())
    await run(port.connect(ORIGIN, GROUP, ACCOUNT, SESSION_MAX_AGE_MS))

    vi.advanceTimersByTime(SESSION_MAX_AGE_MS - 1)
    expect(await run(port.isConnected(ORIGIN, GROUP, ACCOUNT))).toBe(true)

    vi.advanceTimersByTime(2)
    expect(await run(port.isConnected(ORIGIN, GROUP, ACCOUNT))).toBe(false)
  })

  it('keeps an until-revoked grant past the default lifetime', async () => {
    vi.useFakeTimers()
    const port = makeSessionPort(makeInMemorySessionStore())
    await run(port.connect(ORIGIN, GROUP, ACCOUNT, null))
    vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000)
    expect(await run(port.isConnected(ORIGIN, GROUP, ACCOUNT))).toBe(true)
  })

  it('fails closed when the store cannot be read', async () => {
    const broken: SessionStore = {
      load: Effect.die(new Error('storage unavailable')),
      save: () => Effect.void,
    }
    expect(await run(makeSessionPort(broken).isConnected(ORIGIN, GROUP))).toBe(false)
  })
})
