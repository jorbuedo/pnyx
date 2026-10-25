import {Effect, Ref, Stream, SubscriptionRef} from 'effect'
import {beforeEach, describe, expect, it, vi} from 'vitest'

const warn = vi.fn()
vi.mock('../logger', () => ({logger: {debug: vi.fn(), info: vi.fn(), warn, error: vi.fn()}}))

const {subscribeToRef} = await import('./service-state-subscription')

/** The fiber runs on the Effect scheduler, so a change is delivered on a later microtask, not inline. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('subscribeToRef', () => {
  it('delivers the current value on subscribe, before anything has changed', async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make(1))
    const seen = vi.fn()
    const off = subscribeToRef(ref, seen)
    await settle()
    // Documented rather than incidental: a caller must not read the first call as "something changed".
    expect(seen).toHaveBeenCalledTimes(1)
    off()
  })

  it('delivers a change', async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make(1))
    const seen = vi.fn()
    const off = subscribeToRef(ref, seen)
    await settle()
    await Effect.runPromise(SubscriptionRef.set(ref, 2))
    await settle()
    expect(seen).toHaveBeenCalledTimes(2)
    off()
  })

  it('stops delivering once unsubscribed', async () => {
    // The point of the fiber over a `let cancelled` flag: unsubscribing interrupts the work rather
    // than letting it finish and discarding the result.
    const ref = await Effect.runPromise(SubscriptionRef.make(1))
    const seen = vi.fn()
    const off = subscribeToRef(ref, seen)
    await settle()
    off()
    await settle()
    const before = seen.mock.calls.length
    await Effect.runPromise(SubscriptionRef.set(ref, 2))
    await Effect.runPromise(SubscriptionRef.set(ref, 3))
    await settle()
    expect(seen).toHaveBeenCalledTimes(before)
  })

  it('two subscribers are independent — unsubscribing one leaves the other', async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make(1))
    const a = vi.fn()
    const b = vi.fn()
    const offA = subscribeToRef(ref, a)
    const offB = subscribeToRef(ref, b)
    await settle()
    offA()
    await settle()
    const aBefore = a.mock.calls.length
    await Effect.runPromise(SubscriptionRef.set(ref, 2))
    await settle()
    expect(a).toHaveBeenCalledTimes(aBefore)
    expect(b.mock.calls.length).toBeGreaterThan(aBefore - 1)
    offB()
  })

  it('logs and isolates a listener that throws, rather than taking the writer down', async () => {
    // A screen whose render callback throws must not stop the rail that writes the ref. The failure is
    // logged because a surface that silently stops updating is undiagnosable.
    const ref = await Effect.runPromise(SubscriptionRef.make(1))
    const off = subscribeToRef(ref, () => {
      throw new Error('a listener blew up')
    })
    await settle()
    expect(warn).toHaveBeenCalledWith(
      'a store subscription ended; this surface will stop updating',
      expect.objectContaining({origin: 'service-state-subscription'}),
    )
    // The ref is still writable and readable — the subscription died, nothing else did.
    await Effect.runPromise(SubscriptionRef.set(ref, 2))
    expect(await Effect.runPromise(SubscriptionRef.get(ref))).toBe(2)
    off()
  })

  it('a map ref hands back a stable value identity while unchanged, which useSyncExternalStore requires', async () => {
    // Guards the loop condition named in useServiceState's header: a selector returning a fresh object
    // every call makes useSyncExternalStore re-render forever. `map.get(key)` does not.
    const value = {balance: 1n}
    const ref = await Effect.runPromise(
      SubscriptionRef.make<ReadonlyMap<string, {balance: bigint}>>(new Map([['k', value]])),
    )
    const first = (await Effect.runPromise(SubscriptionRef.get(ref))).get('k')
    const second = (await Effect.runPromise(SubscriptionRef.get(ref))).get('k')
    expect(first).toBe(second)
  })

  it('emits nothing extra when a set writes an equal reference', async () => {
    // `SubscriptionRef` compares by reference, so re-storing the same map is not a change. This is what
    // stops a no-op write waking every screen — the defect the callback bus had, where writing a lock
    // republished `midnight-unshielded` and made two hooks re-parse a blob that had not moved.
    const map: ReadonlyMap<string, number> = new Map([['k', 1]])
    const ref = await Effect.runPromise(SubscriptionRef.make(map))
    const seen = vi.fn()
    const off = subscribeToRef(ref, seen)
    await settle()
    const baseline = seen.mock.calls.length
    await Effect.runPromise(SubscriptionRef.set(ref, map))
    await settle()
    expect(seen).toHaveBeenCalledTimes(baseline)
    off()
  })
})

describe('the Ref API on a SubscriptionRef', () => {
  it('publishes — so a writer holding one as a plain Ref still wakes subscribers', async () => {
    // `SubscriptionRef` extends `Ref`, so `Ref.update(state, …)` type-checks against one and a reader
    // cannot tell from the call site whether it announces itself. `wallet-service` and
    // `hardware-wallet-service` both still reach for the `Ref` API on their state, and the listener
    // `Set` that used to guarantee delivery is gone — so if this ever stopped publishing, both would
    // go quiet with nothing failing to compile.
    const ref = await Effect.runPromise(SubscriptionRef.make(1))
    const seen = vi.fn()
    const off = subscribeToRef(ref, seen)
    await settle()
    const baseline = seen.mock.calls.length
    await Effect.runPromise(Ref.update(ref, (n) => n + 1))
    await settle()
    expect(seen).toHaveBeenCalledTimes(baseline + 1)
    expect(await Effect.runPromise(SubscriptionRef.get(ref))).toBe(2)
    off()
  })

  it('is runSync-able while a subscriber is attached', async () => {
    // `hardware-wallet-service` writes its state from 17 `Effect.runSync(updateState(...))` sites,
    // several inside Trezor callbacks that must answer a `Promise` the device is waiting on. A
    // `SubscriptionRef` write takes a semaphore and publishes, where the plain `Ref` write it replaced
    // could not suspend at all — if that critical section ever yielded, every one of those sites would
    // throw, and only with a device attached.
    const ref = await Effect.runPromise(SubscriptionRef.make(0))
    const seen = vi.fn()
    const off = subscribeToRef(ref, seen)
    await settle()
    expect(() => Effect.runSync(SubscriptionRef.update(ref, (n) => n + 1))).not.toThrow()
    expect(await Effect.runPromise(SubscriptionRef.get(ref))).toBe(1)
    off()
  })
})

describe('the stream itself', () => {
  it('replays the current value to a late subscriber', async () => {
    // Why a hook mounting after a sync still paints: it does not need the write to have been announced
    // while it was listening, which is exactly what the callback bus could not offer.
    const ref = await Effect.runPromise(SubscriptionRef.make(1))
    await Effect.runPromise(SubscriptionRef.set(ref, 42))
    const first = await Effect.runPromise(Stream.runHead(ref.changes))
    expect(first._tag === 'Some' && first.value).toBe(42)
  })
})
