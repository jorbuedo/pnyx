import {afterEach, describe, expect, it, vi} from 'vitest'
import {getLogger, loggerRegistry} from './registry.js'
import type {LogTransport, LogTransportOptions} from './types.js'

afterEach(() => {
  loggerRegistry.reset()
})

const makeTransport = (): {readonly transport: LogTransport; readonly calls: LogTransportOptions[]} => {
  const calls: LogTransportOptions[] = []
  const transport: LogTransport = (opts) => {
    calls.push(opts)
  }
  return {transport, calls}
}

describe('loggerRegistry', () => {
  it('returns the same logger instance for the same name', () => {
    const a = getLogger('pkg-a')
    const b = getLogger('pkg-a')
    expect(a).toBe(b)
  })

  it('returns different loggers for different names', () => {
    const a = getLogger('pkg-a')
    const b = getLogger('pkg-b')
    expect(a).not.toBe(b)
  })

  it('fans out a registry transport to every named logger', () => {
    const a = getLogger('pkg-a')
    const b = getLogger('pkg-b')
    const {transport, calls} = makeTransport()
    loggerRegistry.addTransport(transport)

    a.info('hello-a')
    b.info('hello-b')

    expect(calls.map((c) => c.message)).toEqual(['hello-a', 'hello-b'])
  })

  it('wires registry transports onto loggers created AFTER addTransport', () => {
    const {transport, calls} = makeTransport()
    loggerRegistry.addTransport(transport)
    const late = getLogger('pkg-late')
    late.info('late-call')
    expect(calls.map((c) => c.message)).toEqual(['late-call'])
  })

  it('unsubscribe removes the transport from every named logger', () => {
    const a = getLogger('pkg-a')
    const b = getLogger('pkg-b')
    const {transport, calls} = makeTransport()
    const unsub = loggerRegistry.addTransport(transport)

    a.info('first')
    unsub()
    a.info('after-unsub-a')
    b.info('after-unsub-b')

    expect(calls.map((c) => c.message)).toEqual(['first'])
  })

  it('idempotent: registering the same transport twice does not double-emit', () => {
    const a = getLogger('pkg-a')
    const {transport, calls} = makeTransport()
    loggerRegistry.addTransport(transport)
    loggerRegistry.addTransport(transport)
    a.info('once')
    expect(calls).toHaveLength(1)
  })

  it('setLevel applies to existing AND future loggers', () => {
    const a = getLogger('pkg-a', {level: 'debug'})
    loggerRegistry.setLevel('warn')
    const b = getLogger('pkg-b')

    expect(a.level).toBe('warn')
    expect(b.level).toBe('warn')
  })

  it('reset() drops named loggers and removes registry transports', () => {
    const {transport, calls} = makeTransport()
    loggerRegistry.addTransport(transport)
    const a = getLogger('pkg-a')
    a.info('before')
    loggerRegistry.reset()

    const aAgain = getLogger('pkg-a')
    aAgain.info('after')

    expect(calls.map((c) => c.message)).toEqual(['before'])
    expect(a).not.toBe(aAgain)
  })

  it('passes message + metadata through unchanged', () => {
    const a = getLogger('pkg-a')
    const {transport, calls} = makeTransport()
    loggerRegistry.addTransport(transport)

    a.warn('something', {origin: 'unit', code: 42})

    expect(calls).toHaveLength(1)
    const [first] = calls
    if (!first) throw new Error('expected first call')
    expect(first.message).toBe('something')
    expect(first.metadata).toEqual({origin: 'unit', code: 42})
    expect(first.level).toBe('warn')
  })

  it('getNamedLoggers returns one entry per registered name', () => {
    getLogger('alpha')
    getLogger('beta')
    const names = loggerRegistry.getNamedLoggers().map((e) => e.name)
    expect(new Set(names)).toEqual(new Set(['alpha', 'beta']))
  })
})

describe('createLogger isolation invariant', () => {
  it('createLogger() does not gain registry transports', async () => {
    const {createLogger} = await import('./logger.js')
    const isolated = createLogger()
    const {transport, calls} = makeTransport()
    loggerRegistry.addTransport(transport)

    isolated.info('isolated-call')
    expect(calls).toHaveLength(0)

    const spy = vi.fn()
    isolated.addTransport(spy)
    isolated.info('isolated-call-with-own-transport')
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
