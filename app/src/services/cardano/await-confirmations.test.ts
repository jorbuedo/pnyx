import {Provider, TransactionHash} from '@evolution-sdk/evolution'
import {Effect, TestClock, TestContext} from 'effect'
import {describe, expect, it} from 'vitest'
import {AWAIT_INTERVAL_MS, awaitConfirmations} from './await-confirmations'

const HASH = TransactionHash.fromHex('ab'.repeat(32))

/** A backend whose depth answers are scripted, one per call, counting the calls. */
const depthBackend = (answers: ReadonlyArray<number | null>) => {
  let calls = 0
  return {
    calls: () => calls,
    provider: {
      awaitTx: () => Effect.succeed(true),
      getTxConfirmations: () => {
        const answer = answers[calls] ?? null
        calls++
        return Effect.succeed(answer)
      },
    } satisfies Pick<Provider.ProviderEffect, 'awaitTx' | 'getTxConfirmations'>,
  }
}

/** Run with a test clock so the polling interval does not cost real seconds. */
const runPolling = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(effect)
      // Advance past every interval the loop could wait on.
      yield* TestClock.adjust(`${AWAIT_INTERVAL_MS * 50} millis`)
      return yield* fiber.await
    }).pipe(Effect.provide(TestContext.TestContext)),
  )

describe('awaitConfirmations', () => {
  it('returns true as soon as the wanted depth is reported', async () => {
    const {provider, calls} = depthBackend([null, 1, 2, 3])
    const exit = await runPolling(awaitConfirmations(provider, HASH, {confirmations: 2, intervalMs: 10}))
    expect(exit._tag === 'Success' && exit.value).toBe(true)
    // Stops at the answer that satisfies it: null, 1, then 2. A fourth call would mean
    // the loop kept polling past success.
    expect(calls()).toBe(3)
  })

  it('treats null as "not seen yet" rather than as a depth of zero', async () => {
    const {provider} = depthBackend([null, null, 1])
    const exit = await runPolling(awaitConfirmations(provider, HASH, {confirmations: 1, intervalMs: 10}))
    expect(exit._tag === 'Success' && exit.value).toBe(true)
  })

  it('returns false when the attempts run out, which is not an error', async () => {
    const {provider, calls} = depthBackend([1, 1, 1])
    const exit = await runPolling(awaitConfirmations(provider, HASH, {confirmations: 5, tries: 3, intervalMs: 10}))
    expect(exit._tag === 'Success' && exit.value).toBe(false)
    expect(calls()).toBe(3)
  })

  it('does not sleep after the last attempt', async () => {
    // One try, a ten-minute interval, and a one-second deadline: the loop must answer
    // without ever waiting. Bounded rather than left to hang, so losing the guard fails
    // this in a second instead of stalling the suite for the whole interval.
    const {provider} = depthBackend([null])
    const answer = await Effect.runPromise(
      awaitConfirmations(provider, HASH, {tries: 1, intervalMs: 600_000, confirmations: 1}).pipe(
        Effect.timeoutTo({duration: '1 second', onTimeout: () => 'slept' as const, onSuccess: (a) => a}),
      ),
    )
    expect(answer).toBe(false)
  })

  it('serves depth 1 from presence when the backend cannot report depth', async () => {
    const provider = {awaitTx: () => Effect.succeed(true)} satisfies Pick<Provider.ProviderEffect, 'awaitTx'>
    expect(await Effect.runPromise(awaitConfirmations(provider, HASH))).toBe(true)
  })

  it('REFUSES a deeper request rather than answering it from presence', async () => {
    const provider = {awaitTx: () => Effect.succeed(true)} satisfies Pick<Provider.ProviderEffect, 'awaitTx'>
    const exit = await Effect.runPromiseExit(awaitConfirmations(provider, HASH, {confirmations: 3}))
    expect(exit._tag).toBe('Failure')
    expect(String(exit)).toContain('reports presence, not depth')
  })

  it('propagates a backend failure instead of reading it as "not deep enough"', async () => {
    const provider = {
      awaitTx: () => Effect.succeed(true),
      getTxConfirmations: () => Effect.fail(new Provider.ProviderError({message: 'getTxConfirmations failed'})),
    } satisfies Pick<Provider.ProviderEffect, 'awaitTx' | 'getTxConfirmations'>
    const exit = await Effect.runPromiseExit(awaitConfirmations(provider, HASH, {tries: 2, intervalMs: 1}))
    expect(exit._tag).toBe('Failure')
  })
})
