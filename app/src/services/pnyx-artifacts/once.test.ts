import {describe, expect, it} from 'vitest'
import {startOnce} from './once'

/** A promise whose settlement this test controls. */
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return {promise, resolve}
}

/** Let a already-settled promise's `.catch` run before asserting on the latch. */
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('startOnce', () => {
  it('runs the task on the first call', () => {
    let runs = 0
    startOnce('label', async () => {
      runs++
    })()
    expect(runs).toBe(1)
  })

  it('does not start a second run while the first is still going', () => {
    let runs = 0
    const d = deferred()
    const start = startOnce('label', () => {
      runs++
      return d.promise
    })
    start()
    start()
    start()
    expect(runs).toBe(1)
  })

  it('does not re-run after the task succeeded', async () => {
    let runs = 0
    const d = deferred()
    const start = startOnce('label', () => {
      runs++
      return d.promise
    })
    start()
    d.resolve()
    await d.promise
    await flush()
    start()
    expect(runs).toBe(1)
  })

  it('re-arms after a failure so a later call retries', async () => {
    let runs = 0
    const start = startOnce('label', () => {
      runs++
      return Promise.reject(new Error('network down'))
    })
    start()
    await flush()
    start()
    expect(runs).toBe(2)
  })

  it('does not let the task rejection escape to the caller', async () => {
    const start = startOnce('label', () => Promise.reject(new Error('boom')))
    expect(() => start()).not.toThrow()
    await flush()
  })
})
