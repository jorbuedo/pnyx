import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {consoleTransport, createLogger} from './logger'
import type {LogTransportOptions} from './types'
import {LogLevel} from './types'

describe('createLogger', () => {
  describe('basic logging', () => {
    it('should create a logger with default info level', () => {
      const logger = createLogger()
      expect(logger.level).toBe(LogLevel.Info)
    })

    it('should create a logger with specified level', () => {
      const logger = createLogger({level: LogLevel.Debug})
      expect(logger.level).toBe(LogLevel.Debug)
    })

    it('should log messages through transports', () => {
      const logger = createLogger({level: LogLevel.Debug})
      const transport = vi.fn()
      logger.addTransport(transport)

      logger.info('test message', {origin: 'TestModule'})

      expect(transport).toHaveBeenCalledTimes(1)
      expect(transport).toHaveBeenCalledWith(
        expect.objectContaining({
          level: LogLevel.Info,
          message: 'test message',
          metadata: {origin: 'TestModule'},
        }),
      )
    })

    it('should support all log levels', () => {
      const logger = createLogger({level: LogLevel.Debug})
      const transport = vi.fn()
      logger.addTransport(transport)

      logger.debug('debug message')
      logger.info('info message')
      logger.warn('warn message')
      logger.error('error message')

      expect(transport).toHaveBeenCalledTimes(4)
      expect(transport).toHaveBeenNthCalledWith(1, expect.objectContaining({level: LogLevel.Debug}))
      expect(transport).toHaveBeenNthCalledWith(2, expect.objectContaining({level: LogLevel.Info}))
      expect(transport).toHaveBeenNthCalledWith(3, expect.objectContaining({level: LogLevel.Warn}))
      expect(transport).toHaveBeenNthCalledWith(4, expect.objectContaining({level: LogLevel.Error}))
    })

    it('should handle Error objects in error()', () => {
      const logger = createLogger()
      const transport = vi.fn()
      logger.addTransport(transport)

      const error = new Error('test error')
      logger.error(error, {origin: 'ErrorTest'})

      expect(transport).toHaveBeenCalledWith(
        expect.objectContaining({
          level: LogLevel.Error,
          message: error,
          metadata: {origin: 'ErrorTest'},
        }),
      )
    })
  })

  describe('log level filtering', () => {
    it('should filter messages below current level', () => {
      const logger = createLogger({level: LogLevel.Warn})
      const transport = vi.fn()
      logger.addTransport(transport)

      logger.debug('debug')
      logger.info('info')
      logger.warn('warn')
      logger.error('error')

      expect(transport).toHaveBeenCalledTimes(2)
      expect(transport).toHaveBeenNthCalledWith(1, expect.objectContaining({level: LogLevel.Warn}))
      expect(transport).toHaveBeenNthCalledWith(2, expect.objectContaining({level: LogLevel.Error}))
    })

    it('should allow changing log level', () => {
      const logger = createLogger({level: LogLevel.Error})
      const transport = vi.fn()
      logger.addTransport(transport)

      logger.info('before')
      expect(transport).toHaveBeenCalledTimes(0)

      logger.setLevel(LogLevel.Info)
      logger.info('after')
      expect(transport).toHaveBeenCalledTimes(1)
    })
  })

  describe('origin filtering', () => {
    it('should filter by origin when filter is set', () => {
      const logger = createLogger({level: LogLevel.Debug})
      const transport = vi.fn()
      logger.addTransport(transport)

      logger.setFilter(/WalletService/)

      logger.info('wallet log', {origin: 'WalletService'})
      logger.info('other log', {origin: 'OtherService'})
      logger.info('no origin log')

      expect(transport).toHaveBeenCalledTimes(1)
      expect(transport).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: {origin: 'WalletService'},
        }),
      )
    })

    it('should clear filter when set to null', () => {
      const logger = createLogger({level: LogLevel.Debug})
      const transport = vi.fn()
      logger.addTransport(transport)

      logger.setFilter(/WalletService/)
      logger.info('filtered', {origin: 'OtherService'})
      expect(transport).toHaveBeenCalledTimes(0)

      logger.setFilter(null)
      logger.info('not filtered', {origin: 'OtherService'})
      expect(transport).toHaveBeenCalledTimes(1)
    })

    it('should expose current filter', () => {
      const logger = createLogger()
      expect(logger.filter).toBeNull()

      const filter = /Test/
      logger.setFilter(filter)
      expect(logger.filter).toBe(filter)
    })
  })

  describe('enable/disable', () => {
    it('should not log when disabled', () => {
      const logger = createLogger()
      const transport = vi.fn()
      logger.addTransport(transport)

      logger.disable()
      logger.info('test')

      expect(transport).not.toHaveBeenCalled()
    })

    it('should resume logging when re-enabled', () => {
      const logger = createLogger()
      const transport = vi.fn()
      logger.addTransport(transport)

      logger.disable()
      logger.info('disabled')
      logger.enable()
      logger.info('enabled')

      expect(transport).toHaveBeenCalledTimes(1)
      expect(transport).toHaveBeenCalledWith(expect.objectContaining({message: 'enabled'}))
    })
  })

  describe('transport management', () => {
    it('should support multiple transports', () => {
      const logger = createLogger()
      const transport1 = vi.fn()
      const transport2 = vi.fn()
      logger.addTransport(transport1)
      logger.addTransport(transport2)

      logger.info('test')

      expect(transport1).toHaveBeenCalledTimes(1)
      expect(transport2).toHaveBeenCalledTimes(1)
    })

    it('should return unsubscribe function', () => {
      const logger = createLogger()
      const transport = vi.fn()
      const unsubscribe = logger.addTransport(transport)

      logger.info('before')
      unsubscribe()
      logger.info('after')

      expect(transport).toHaveBeenCalledTimes(1)
    })

    it('should silently catch transport errors', () => {
      const logger = createLogger()
      const failingTransport = vi.fn(() => {
        throw new Error('Transport failed')
      })
      const workingTransport = vi.fn()

      logger.addTransport(failingTransport)
      logger.addTransport(workingTransport)

      expect(() => logger.info('test')).not.toThrow()
      expect(workingTransport).toHaveBeenCalledTimes(1)
    })
  })

  describe('trail buffer', () => {
    it('should store log entries in trail', () => {
      const logger = createLogger({level: LogLevel.Debug})
      const transport = vi.fn()
      logger.addTransport(transport)

      logger.info('first')
      logger.debug('second')
      logger.warn('third')

      expect(logger.trail).toHaveLength(3)
      expect(logger.trail[0]?.message).toBe('first')
      expect(logger.trail[1]?.message).toBe('second')
      expect(logger.trail[2]?.message).toBe('third')
    })

    it('should limit trail to 1000 entries', () => {
      const logger = createLogger()
      const transport = vi.fn()
      logger.addTransport(transport)

      for (let i = 0; i < 1050; i++) {
        logger.info(`message ${i}`)
      }

      expect(logger.trail).toHaveLength(1000)
      expect(logger.trail[0]?.message).toBe('message 50')
      expect(logger.trail[999]?.message).toBe('message 1049')
    })

    it('should include metadata and timestamp in trail entries', () => {
      const logger = createLogger()
      const transport = vi.fn()
      logger.addTransport(transport)

      const before = Date.now()
      logger.info('test', {origin: 'TestModule', extra: 'data'})
      const after = Date.now()

      const entry = logger.trail[0]
      expect(entry?.level).toBe(LogLevel.Info)
      expect(entry?.message).toBe('test')
      expect(entry?.metadata).toEqual({origin: 'TestModule', extra: 'data'})
      expect(entry?.timestamp).toBeGreaterThanOrEqual(before)
      expect(entry?.timestamp).toBeLessThanOrEqual(after)
      expect(entry?.id).toMatch(/^log-\d+-\d+$/)
    })

    it('should convert Error to message string in trail', () => {
      const logger = createLogger()
      const transport = vi.fn()
      logger.addTransport(transport)

      const error = new Error('test error')
      logger.error(error)

      expect(logger.trail[0]?.message).toBe('test error')
    })

    it('should not add to trail when disabled', () => {
      const logger = createLogger()
      logger.disable()
      logger.info('test')

      expect(logger.trail).toHaveLength(0)
    })

    it('should return readonly trail', () => {
      const logger = createLogger()
      logger.info('test')

      const trail = logger.trail
      expect(Array.isArray(trail)).toBe(true)
    })
  })
})

describe('consoleTransport', () => {
  // Note: consoleTransport uses appropriate console methods per level:
  // - info: console.info
  // - debug: console.debug
  // - warn: console.warn
  // - error: console.error (or console.log if Error object for stack trace)
  let infoSpy: ReturnType<typeof vi.spyOn>
  let debugSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should log to console.info for info level', () => {
    const options: LogTransportOptions = {
      level: LogLevel.Info,
      message: 'test message',
      metadata: {origin: 'TestModule'},
      timestamp: Date.now(),
    }

    consoleTransport(options)

    expect(infoSpy).toHaveBeenCalledTimes(1)
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('INFO'))
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('[TestModule]'))
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('test message'))
  })

  it('should log to console.debug for debug level', () => {
    const options: LogTransportOptions = {
      level: LogLevel.Debug,
      message: 'debug message',
      metadata: {},
      timestamp: Date.now(),
    }

    consoleTransport(options)

    expect(debugSpy).toHaveBeenCalledTimes(1)
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('DEBUG'))
  })

  it('should log to console.warn for warn level', () => {
    const options: LogTransportOptions = {
      level: LogLevel.Warn,
      message: 'warn message',
      metadata: {},
      timestamp: Date.now(),
    }

    consoleTransport(options)

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('WARN'))
  })

  it('should log to console.warn for error level', () => {
    const options: LogTransportOptions = {
      level: LogLevel.Error,
      message: 'error message',
      metadata: {},
      timestamp: Date.now(),
    }

    consoleTransport(options)

    // Error level uses console.warn to avoid Metro showing logger stack traces
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ERROR'))
  })

  it('should include Error object in output via console.warn', () => {
    const error = new Error('test error')
    const options: LogTransportOptions = {
      level: LogLevel.Error,
      message: error,
      metadata: {},
      timestamp: Date.now(),
    }

    consoleTransport(options)

    // Error objects are logged with console.warn alongside the Error instance
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('test error'), error)
  })

  it('should include extra metadata as JSON', () => {
    const options: LogTransportOptions = {
      level: LogLevel.Info,
      message: 'test',
      metadata: {origin: 'Test', extra: 'value', count: 42},
      timestamp: Date.now(),
    }

    consoleTransport(options)

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('"extra":"value"'))
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('"count":42'))
  })

  it('should not include empty extra metadata', () => {
    const options: LogTransportOptions = {
      level: LogLevel.Info,
      message: 'test',
      metadata: {origin: 'Test', type: 'info'},
      timestamp: Date.now(),
    }

    consoleTransport(options)

    const call = infoSpy.mock.calls[0][0] as string
    expect(call).not.toContain('{}')
  })
})
