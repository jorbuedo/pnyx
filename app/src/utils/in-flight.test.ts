import {describe, expect, it} from 'vitest'
import {inFlight} from './in-flight'

describe('inFlight', () => {
  // ⚠️ The measured defect: six identical requests in nine milliseconds, because a result cache is
  // still empty while the first request is in the air.
  it('runs once for callers that arrive together', async () => {
    const store = new Map<string, Promise<number>>()
    let runs = 0
    const slow = () =>
      new Promise<number>((resolve) => {
        runs += 1
        setTimeout(() => resolve(runs), 5)
      })

    const results = await Promise.all([
      inFlight(store, 'k', slow),
      inFlight(store, 'k', slow),
      inFlight(store, 'k', slow),
      inFlight(store, 'k', slow),
      inFlight(store, 'k', slow),
      inFlight(store, 'k', slow),
    ])
    expect(runs).toBe(1)
    expect(results).toEqual([1, 1, 1, 1, 1, 1])
  })

  it('keeps a settled result for later callers', async () => {
    const store = new Map<string, Promise<string>>()
    let runs = 0
    const once = async () => {
      runs += 1
      return 'value'
    }
    expect(await inFlight(store, 'k', once)).toBe('value')
    expect(await inFlight(store, 'k', once)).toBe('value')
    expect(runs).toBe(1)
  })

  it('keeps different keys apart', async () => {
    const store = new Map<string, Promise<string>>()
    expect(await inFlight(store, 'a', async () => 'A')).toBe('A')
    expect(await inFlight(store, 'b', async () => 'B')).toBe('B')
  })

  // A cached rejection would turn one failed request into a permanent answer.
  it('does not cache a rejection, so a retry is possible', async () => {
    const store = new Map<string, Promise<string>>()
    let attempts = 0
    const flaky = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('transient')
      return 'ok'
    }
    await expect(inFlight(store, 'k', flaky)).rejects.toThrow('transient')
    expect(store.has('k')).toBe(false)
    expect(await inFlight(store, 'k', flaky)).toBe('ok')
    expect(attempts).toBe(2)
  })

  it('propagates the rejection to every waiter that shared it', async () => {
    const store = new Map<string, Promise<string>>()
    const failing = () => new Promise<string>((_, reject) => setTimeout(() => reject(new Error('nope')), 5))
    const a = inFlight(store, 'k', failing)
    const b = inFlight(store, 'k', failing)
    await expect(a).rejects.toThrow('nope')
    await expect(b).rejects.toThrow('nope')
  })
})
