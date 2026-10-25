import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {classifyKoiosRefusal, type KoiosRefusal, retryKoiosRefusal} from './koios-refusal'

// The two bodies below are verbatim from the live endpoint: the first provoked by
// bursting past the tier window, the second is what a device was refused with.
const BURST = '429 Exceeded Burst Limit, count was 76'
const SHED =
  '429 <html><body><h1>429 Too Many Requests</h1>\nYou have sent too many requests in a given amount of time.\n</body></html>\n'

describe('classifyKoiosRefusal', () => {
  it('reads the tier limiter from its body', () => {
    expect(classifyKoiosRefusal(BURST)?.kind).toBe('burst')
  })

  it('reads an instance shedding load from the HAProxy page', () => {
    expect(classifyKoiosRefusal(SHED)?.kind).toBe('shed')
  })

  it('strips the markup so the detail is readable in a log line', () => {
    expect(classifyKoiosRefusal(SHED)?.detail).toBe(
      '429 Too Many Requests You have sent too many requests in a given amount of time.',
    )
  })

  it('still classifies a 429 whose body is new to us — it is a come-back-later either way', () => {
    expect(classifyKoiosRefusal('429 something we have never seen')?.kind).toBe('unclassified')
  })

  it('is not fooled by another status, so a 400 is never retried as a rate limit', () => {
    expect(classifyKoiosRefusal('400 bad request')).toBeNull()
    expect(classifyKoiosRefusal('503 upstream down')).toBeNull()
  })

  it('does not match a 429 appearing anywhere other than the status', () => {
    // The status is the leading token. A body mentioning the number is not a refusal.
    expect(classifyKoiosRefusal('200 [{"amount":"429"}]')).toBeNull()
    expect(classifyKoiosRefusal('4290 nonsense')).toBeNull()
  })
})

describe('retryKoiosRefusal', () => {
  const failing = (failures: number, message: string) => {
    let attempts = 0
    const effect = Effect.suspend(() => {
      attempts += 1
      return attempts <= failures ? Effect.fail(new Error(message)) : Effect.succeed(attempts)
    })
    return {effect, attempts: () => attempts}
  }

  it('asks again after a shed, and answers once the endpoint does', async () => {
    const {effect, attempts} = failing(1, SHED)
    const seen: KoiosRefusal[] = []
    const result = await Effect.runPromise(
      retryKoiosRefusal(effect, {reasonOf: (e) => e.message, onRefusal: (r) => seen.push(r)}),
    )
    expect(result).toBe(2)
    expect(attempts()).toBe(2)
    expect(seen.map((r) => r.kind)).toEqual(['shed'])
  })

  it('gives up rather than hammering — a daily quota cannot be waited out', async () => {
    const {effect, attempts} = failing(99, SHED)
    const exit = await Effect.runPromiseExit(retryKoiosRefusal(effect, {reasonOf: (e) => e.message}))
    expect(exit._tag).toBe('Failure')
    // The first attempt plus three retries.
    expect(attempts()).toBe(4)
  }, 20_000)

  it('does not retry a failure that is not a refusal', async () => {
    const {effect, attempts} = failing(99, '400 bad request')
    const exit = await Effect.runPromiseExit(retryKoiosRefusal(effect, {reasonOf: (e) => e.message}))
    expect(exit._tag).toBe('Failure')
    expect(attempts()).toBe(1)
  })

  it('reports every refusal it saw, so a retried walk is not silent', async () => {
    const {effect} = failing(2, BURST)
    const seen: KoiosRefusal[] = []
    await Effect.runPromise(retryKoiosRefusal(effect, {reasonOf: (e) => e.message, onRefusal: (r) => seen.push(r)}))
    expect(seen.map((r) => r.kind)).toEqual(['burst', 'burst'])
  })
})
