/**
 * The realtime client: frame handling, the reconnect policy, and that a (re)connect triggers the
 * refetch which is this design's entire catch-up mechanism.
 */

import {beforeEach, describe, expect, it, vi} from 'vitest'
import {reconnectDelayMs, shouldReconnect} from './backoff'
import {connectRealtime, decodeEvent} from './client'

vi.mock('../../logger', () => ({logger: {debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn()}}))
vi.mock('../pnyx-session', () => ({serviceUrl: () => 'https://svc.test'}))

/** A socket whose lifecycle the test drives. */
class FakeSocket {
  static made: FakeSocket[] = []
  onopen?: () => void
  onmessage?: (m: {data?: unknown}) => void
  onerror?: () => void
  onclose?: (e: {code?: number}) => void
  closedWith: number | undefined
  sent: string[] = []
  sendThrows = false
  constructor(readonly url: string) {
    FakeSocket.made.push(this)
  }
  send(data: string) {
    if (this.sendThrows) throw new Error('socket is gone')
    this.sent.push(data)
  }
  close(code?: number) {
    this.closedWith = code
  }
}

/** A controllable `setInterval`, so a heartbeat can be stepped without waiting 25 seconds. */
const makeTicker = () => {
  const ticks = new Map<number, () => void>()
  let next = 1
  return {
    setInterval: ((fn: () => void) => {
      const id = next++
      ticks.set(id, fn)
      return id as unknown as ReturnType<typeof setInterval>
    }) as unknown as typeof setInterval,
    clearInterval: ((id: number) => {
      ticks.delete(id)
    }) as unknown as typeof clearInterval,
    tick: (times = 1) => {
      for (let i = 0; i < times; i++) for (const fn of [...ticks.values()]) fn()
    },
    running: () => ticks.size,
  }
}

const frame = (event: unknown) => JSON.stringify({v: 1, event})

beforeEach(() => {
  FakeSocket.made = []
})

const connect = (overrides: Parameters<typeof connectRealtime>[1] = {}) =>
  connectRealtime('session-jwt', {
    makeSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    fetchTicket: async () => 'ticket-1',
    setTimeoutImpl: ((fn: () => void) => {
      // Immediate, so a reconnect is observable without fake timers; the delay itself is tested in
      // backoff.test.ts where it is pure.
      fn()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout,
    ...overrides,
  })

describe('decodeEvent', () => {
  it('accepts every kind the service sends', () => {
    expect(decodeEvent(frame({kind: 'dm-waiting'}))).toEqual({kind: 'dm-waiting'})
    expect(decodeEvent(frame({kind: 'chain-settled', communityId: 'c1'}))).toEqual({
      kind: 'chain-settled',
      communityId: 'c1',
    })
    expect(decodeEvent(frame({kind: 'proposal-changed', communityId: 'c1', proposalId: 'p1'}))).toEqual({
      kind: 'proposal-changed',
      communityId: 'c1',
      proposalId: 'p1',
    })
  })

  // The service can ship a new kind long before an app update reaches a store.
  it.each([
    ['garbage', 'nope{'],
    ['a future version', JSON.stringify({v: 2, event: {kind: 'dm-waiting'}})],
    ['an unknown kind', frame({kind: 'circle-deleted', communityId: 'c1'})],
    ['a missing id', frame({kind: 'community-changed'})],
  ])('drops %s', (_label, raw) => {
    expect(decodeEvent(raw)).toBeUndefined()
  })
})

describe('connectRealtime', () => {
  it('opens with a ticket in the query and a ws scheme', async () => {
    connect()
    await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(1))
    expect(FakeSocket.made[0]?.url).toBe('wss://svc.test/realtime?ticket=ticket-1')
  })

  // The whole catch-up mechanism: subscribers refetch on every open, so nothing needs replaying.
  it('notifies subscribers on open, and again on reconnect', async () => {
    const onOpen = vi.fn()
    const connection = connect()
    connection.subscribe({onOpen})
    await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(1))

    FakeSocket.made[0]?.onopen?.()
    expect(onOpen).toHaveBeenCalledTimes(1)

    FakeSocket.made[0]?.onclose?.({code: 1006})
    await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(2))
    FakeSocket.made[1]?.onopen?.()
    expect(onOpen).toHaveBeenCalledTimes(2)
  })

  it('delivers decoded events and ignores keepalives', async () => {
    const onEvent = vi.fn()
    const connection = connect()
    connection.subscribe({onEvent})
    await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(1))
    const ws = FakeSocket.made[0]
    ws?.onopen?.()

    ws?.onmessage?.({data: 'pong'})
    ws?.onmessage?.({data: 'not json'})
    ws?.onmessage?.({data: frame({kind: 'dm-waiting'})})

    expect(onEvent).toHaveBeenCalledExactlyOnceWith({kind: 'dm-waiting'})
  })

  // A subscriber mounted after the socket came up still needs its first read.
  it('gives a late subscriber an immediate open', async () => {
    const connection = connect()
    await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(1))
    FakeSocket.made[0]?.onopen?.()

    const onOpen = vi.fn()
    connection.subscribe({onOpen})
    expect(onOpen).toHaveBeenCalledOnce()
  })

  // Without this, "connected" latches true on the first open and never returns — which made it
  // useless for anything that has to behave differently while the stream is down.
  it('reports a close, and only for a socket that was open', async () => {
    const onOpen = vi.fn()
    const onClose = vi.fn()
    const connection = connect()
    connection.subscribe({onOpen, onClose})
    await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(1))

    // A socket that never opened (a failed connect) must not report a close it never had.
    FakeSocket.made[0]?.onclose?.({code: 1006})
    expect(onClose).not.toHaveBeenCalled()

    await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(2))
    FakeSocket.made[1]?.onopen?.()
    expect(onOpen).toHaveBeenCalledTimes(1)
    FakeSocket.made[1]?.onclose?.({code: 1006})
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // Retrying a policy close in a loop burns battery achieving nothing.
  it('stops reconnecting on a policy close', async () => {
    connect()
    await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(1))
    FakeSocket.made[0]?.onclose?.({code: 1008})
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(FakeSocket.made).toHaveLength(1)
  })

  // A ticket lives 60s, so a reconnect after any real outage must mint a new one rather than replay a
  // stale one — which would be refused and look like a permission problem.
  it('fetches a fresh ticket per attempt', async () => {
    const fetchTicket = vi.fn(async () => 'ticket-n')
    connect({fetchTicket})
    await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(1))
    FakeSocket.made[0]?.onclose?.({code: 1006})
    await vi.waitFor(() => expect(fetchTicket).toHaveBeenCalledTimes(2))
  })

  it('retries when no ticket can be obtained, without opening a socket', async () => {
    let calls = 0
    const fetchTicket = vi.fn(async () => {
      calls += 1
      return calls < 3 ? null : 'ticket-late'
    })
    connect({fetchTicket})
    await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(1))
    expect(fetchTicket).toHaveBeenCalledTimes(3)
  })

  it('stops reconnecting once closed', async () => {
    const connection = connect()
    await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(1))
    connection.close()
    FakeSocket.made[0]?.onclose?.({code: 1006})
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(FakeSocket.made).toHaveLength(1)
    expect(connection.isOpen()).toBe(false)
  })

  it('drops subscribers on unsubscribe', async () => {
    const onEvent = vi.fn()
    const connection = connect()
    const unsubscribe = connection.subscribe({onEvent})
    await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(1))
    FakeSocket.made[0]?.onopen?.()
    unsubscribe()
    FakeSocket.made[0]?.onmessage?.({data: frame({kind: 'dm-waiting'})})
    expect(onEvent).not.toHaveBeenCalled()
  })
})

describe('reconnect policy', () => {
  it('backs off exponentially and caps', () => {
    const noJitter = () => 0.5
    expect(reconnectDelayMs(1, noJitter)).toBe(1_000)
    expect(reconnectDelayMs(2, noJitter)).toBe(2_000)
    expect(reconnectDelayMs(5, noJitter)).toBe(16_000)
    // Capped, so an hour-long outage still reconnects within half a minute of the service returning.
    expect(reconnectDelayMs(20, noJitter)).toBe(30_000)
  })

  // Without jitter every client of a service that just restarted retries in lockstep and re-flattens it.
  it('jitters within ±25%', () => {
    // attempt 3 → 4s base, so ±25% is 3s..5s.
    expect(reconnectDelayMs(3, () => 0)).toBe(3_000)
    expect(reconnectDelayMs(3, () => 1)).toBe(5_000)
  })

  it.each([
    [1006, true],
    [1001, true],
    [1008, false],
    [4401, false],
  ])('retries %i → %s', (code, expected) => {
    expect(shouldReconnect(code)).toBe(expected)
  })
})

describe('renew', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('replaces a socket that claims to be open, and the new one re-fires onOpen', async () => {
    // The resume case: Android dismantles a suspended process's sockets without a close event, so the
    // client believes it is connected and every subscriber's catch-up refetch never runs.
    const onOpen = vi.fn()
    const connection = connect()
    connection.subscribe({onOpen})
    await settle()
    FakeSocket.made[0]?.onopen?.()
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(connection.isOpen()).toBe(true)

    connection.renew()
    await settle()
    expect(FakeSocket.made).toHaveLength(2)
    FakeSocket.made[1]?.onopen?.()
    expect(onOpen).toHaveBeenCalledTimes(2)
  })

  it('does not let the discarded socket schedule a second connect', async () => {
    const connection = connect()
    await settle()
    FakeSocket.made[0]?.onopen?.()
    const discarded = FakeSocket.made[0]
    connection.renew()
    await settle()
    // Its close handler was detached, so replaying it must not add a third socket.
    discarded?.onclose?.({code: 1006})
    await settle()
    expect(FakeSocket.made).toHaveLength(2)
  })

  it('tells subscribers the old socket went away, so a live indicator cannot latch true', async () => {
    const onClose = vi.fn()
    const connection = connect()
    connection.subscribe({onClose})
    await settle()
    FakeSocket.made[0]?.onopen?.()
    connection.renew()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('is inert once the connection is closed', async () => {
    const connection = connect()
    await settle()
    connection.close()
    connection.renew()
    await settle()
    expect(FakeSocket.made).toHaveLength(1)
  })
})

// The socket flapped every 30–90 s on a real device and never on the emulator: a carrier NAT drops an
// idle mapping, and nothing was keeping this one warm.
describe('heartbeat', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  const connectWithTicker = () => {
    const ticker = makeTicker()
    const connection = connect({setIntervalImpl: ticker.setInterval, clearIntervalImpl: ticker.clearInterval})
    return {ticker, connection}
  }

  it('pings only while a socket is open, and stops when it goes away', async () => {
    const {ticker} = connectWithTicker()
    await settle()
    // Nothing ticks before the socket opens: a ping into a connecting socket throws.
    expect(ticker.running()).toBe(0)

    FakeSocket.made[0]?.onopen?.()
    ticker.tick(2)
    expect(FakeSocket.made[0]?.sent).toEqual(['ping', 'ping'])

    FakeSocket.made[0]?.onclose?.({code: 1006})
    expect(ticker.running()).toBe(0)
  })

  it('replaces a socket that stopped answering', async () => {
    const {ticker} = connectWithTicker()
    await settle()
    const ws = FakeSocket.made[0]
    ws?.onopen?.()

    // One answered ping arms the watchdog...
    ticker.tick()
    ws?.onmessage?.({data: 'pong'})
    // ...and two unanswered ones trip it.
    ticker.tick(3)
    await settle()
    expect(FakeSocket.made).toHaveLength(2)
  })

  // A deploy older than the heartbeat answers nothing. That must read as quiet, not as broken —
  // otherwise every client renews on a timer forever, which is a worse flap than the one being fixed.
  it('never renews against a service that has answered no pong at all', async () => {
    const {ticker} = connectWithTicker()
    await settle()
    FakeSocket.made[0]?.onopen?.()
    ticker.tick(10)
    await settle()
    expect(FakeSocket.made).toHaveLength(1)
  })

  it('keeps the connection alive as long as pongs come back', async () => {
    const {ticker} = connectWithTicker()
    await settle()
    const ws = FakeSocket.made[0]
    ws?.onopen?.()
    for (let i = 0; i < 10; i++) {
      ticker.tick()
      ws?.onmessage?.({data: 'pong'})
    }
    await settle()
    expect(FakeSocket.made).toHaveLength(1)
    expect(ws?.sent).toHaveLength(10)
  })

  // A send that throws is a socket already gone; its close event may never come.
  it('renews when the ping itself cannot be sent', async () => {
    const {ticker} = connectWithTicker()
    await settle()
    const ws = FakeSocket.made[0]
    ws?.onopen?.()
    if (ws) ws.sendThrows = true
    ticker.tick()
    await settle()
    expect(FakeSocket.made).toHaveLength(2)
  })

  it('restarts on the new socket after a renew, and leaves nothing running once closed', async () => {
    const {ticker, connection} = connectWithTicker()
    await settle()
    FakeSocket.made[0]?.onopen?.()
    connection.renew()
    await settle()
    FakeSocket.made[1]?.onopen?.()
    ticker.tick()
    expect(FakeSocket.made[0]?.sent).toHaveLength(0)
    expect(FakeSocket.made[1]?.sent).toEqual(['ping'])

    connection.close()
    expect(ticker.running()).toBe(0)
  })
})
