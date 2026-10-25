import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

const loggerMock = vi.hoisted(() => ({warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn()}))
vi.mock('./index', () => ({logger: loggerMock}))

import {watchdog} from './watchdog'

describe('watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    loggerMock.warn.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not warn when the promise settles before the deadline', async () => {
    const p = Promise.resolve('ok')
    const result = watchdog(p, {label: 'fast', thresholdMs: 1000})
    await vi.advanceTimersByTimeAsync(1500)
    await expect(result).resolves.toBe('ok')
    expect(loggerMock.warn).not.toHaveBeenCalled()
  })

  it('warns when the deadline is exceeded but lets the promise settle normally', async () => {
    // `!` is the definite-assignment assertion — TypeScript can't track that
    // the Promise-executor closure runs synchronously and assigns `resolveFn`
    // before we use it. Without it, TS narrows the variable to `never` at the
    // call site below and the test fails to compile in CI (caught by tsc -b
    // even though Vitest's transpile is forgiving).
    let resolveFn!: (v: string) => void
    const p = new Promise<string>((r) => {
      resolveFn = r
    })
    const wrapped = watchdog(p, {label: 'slow', thresholdMs: 1000, context: {groupId: 'g1'}})
    await vi.advanceTimersByTimeAsync(1500)
    expect(loggerMock.warn).toHaveBeenCalledTimes(1)
    const [message, meta] = loggerMock.warn.mock.calls[0] as [string, Record<string, unknown>]
    expect(message).toContain('slow still pending after 1000ms')
    expect(meta.label).toBe('slow')
    expect(meta.thresholdMs).toBe(1000)
    expect(meta.groupId).toBe('g1')
    // The wrapped promise still resolves with the original value.
    resolveFn('eventual')
    await expect(wrapped).resolves.toBe('eventual')
  })

  it('preserves rejection (does not swallow errors)', async () => {
    const p = Promise.reject(new Error('boom'))
    const wrapped = watchdog(p, {label: 'rejecting', thresholdMs: 1000})
    await expect(wrapped).rejects.toThrow('boom')
    expect(loggerMock.warn).not.toHaveBeenCalled()
  })

  it('does not warn after the promise settles, even if the timer would fire later', async () => {
    const p = new Promise<void>((resolve) => {
      setTimeout(resolve, 500)
    })
    const wrapped = watchdog(p, {label: 'settles-then-timer', thresholdMs: 1000})
    await vi.advanceTimersByTimeAsync(2000)
    await wrapped
    expect(loggerMock.warn).not.toHaveBeenCalled()
  })
})
