import {Effect, Either, Fiber, Stream} from 'effect'
import {describe, expect, it} from 'vitest'

import type {SocketEvents, SocketFactory} from './graphql-ws'
import {subscriptionStream} from './graphql-ws'

/**
 * ⚠️ Forked with `Effect.runFork`, not `Effect.fork`: the latter makes the stream a *child* of the
 * effect that forked it, and that parent completes immediately — so structured concurrency interrupts
 * the subscription before a single frame arrives. `WalletProvider` uses `forkDaemon` for the same
 * reason.
 *
 * A scripted server that also lets a test push a frame **after** the initial batch, which is what
 * distinguishes a live feed from a replay. `closed()` reports socket teardown, the thing a stream
 * finaliser has to get right.
 */
const scripted = (
  frames: readonly unknown[],
): {
  factory: SocketFactory
  closed: () => number
  push: (frame: unknown) => void
} => {
  let closes = 0
  let deliver: ((frame: unknown) => void) | undefined
  const factory: SocketFactory = (_url, _protocol, events: SocketEvents) => {
    deliver = (frame: unknown) => events.onMessage(JSON.stringify(frame))
    setTimeout(() => events.onOpen(), 0)
    return {
      send: (data) => {
        const parsed = JSON.parse(data) as {type?: string}
        if (parsed.type === 'connection_init') setTimeout(() => deliver?.({type: 'connection_ack'}), 0)
        if (parsed.type === 'subscribe') setTimeout(() => frames.forEach((f) => deliver?.(f)), 0)
      },
      close: () => {
        closes += 1
      },
    }
  }
  return {factory, closed: () => closes, push: (frame) => deliver?.(frame)}
}

const value = (n: number) => ({type: 'next', id: '1', payload: {data: {n}}})

const streamOf = (factory: SocketFactory) =>
  subscriptionStream<{n: number}>({url: 'ws://x/ws', query: 'subscription {}', variables: {}, socketFactory: factory})

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

describe('subscriptionStream', () => {
  it('emits each payload the server sends', async () => {
    const {factory} = scripted([value(1), value(2), {type: 'complete'}])
    const seen = await Effect.runPromise(Stream.runCollect(streamOf(factory)))
    expect([...seen].map((v) => v.n)).toEqual([1, 2])
  })

  it('stays open after the replay, and delivers what arrives later', async () => {
    // The whole point. `runSubscription` folds the feed into a promise and closes at catch-up, which is
    // why every surface then has to be told to re-read. A stream keeps the feed.
    const {factory, push} = scripted([value(1)])
    const received: number[] = []
    const fiber = Effect.runFork(Stream.runForEach(streamOf(factory), (v) => Effect.sync(() => received.push(v.n))))
    await settle()
    expect(received).toEqual([1])
    push(value(2))
    push(value(3))
    await settle()
    expect(received).toEqual([1, 2, 3])
    await Effect.runPromise(Fiber.interrupt(fiber))
  })

  it('closes the socket when the consumer is interrupted', async () => {
    // Without this a screen going away leaks its socket. The release is what `Stream.asyncPush`'s
    // scope buys over a bare callback.
    const {factory, closed} = scripted([value(1)])
    const fiber = Effect.runFork(Stream.runDrain(streamOf(factory)))
    await settle()
    expect(closed()).toBe(0)
    await Effect.runPromise(Fiber.interrupt(fiber))
    await settle()
    expect(closed()).toBe(1)
  })

  it('stops delivering once interrupted', async () => {
    const {factory, push} = scripted([value(1)])
    const received: number[] = []
    const fiber = Effect.runFork(Stream.runForEach(streamOf(factory), (v) => Effect.sync(() => received.push(v.n))))
    await settle()
    await Effect.runPromise(Fiber.interrupt(fiber))
    push(value(99))
    await settle()
    expect(received).toEqual([1])
  })

  it('fails the stream on a GraphQL error rather than ending it quietly', async () => {
    // An empty result and a refused query must not look the same — the rule the promise version
    // already followed, carried over.
    const {factory} = scripted([{type: 'next', id: '1', payload: {data: null, errors: [{message: 'bad HRP'}]}}])
    const outcome = await Effect.runPromise(Effect.either(Stream.runCollect(streamOf(factory))))
    expect(Either.isLeft(outcome)).toBe(true)
    if (Either.isLeft(outcome)) expect(String(outcome.left)).toMatch(/bad HRP/)
  })

  it('ends cleanly when the server completes', async () => {
    const {factory, closed} = scripted([value(1), {type: 'complete'}])
    await Effect.runPromise(Stream.runDrain(streamOf(factory)))
    await settle()
    // Closed once by the promise's own finish, not left dangling.
    expect(closed()).toBeGreaterThan(0)
  })

  it('holds the socket open through silence — no timeout by default', async () => {
    // `runSubscription` bounds silence at 30 s because a caller reading a replay wants to leave.
    // On a live feed silence is the steady state, so the stream disables it and the fiber is what ends.
    const {factory} = scripted([value(1)])
    const received: number[] = []
    const fiber = Effect.runFork(Stream.runForEach(streamOf(factory), (v) => Effect.sync(() => received.push(v.n))))
    await settle()
    const running = await Effect.runPromise(Fiber.poll(fiber))
    expect(running._tag).toBe('None')
    await Effect.runPromise(Fiber.interrupt(fiber))
  })
})
