import {describe, expect, it, vi} from 'vitest'
import {createSafeNativeMonitorCallback, createSafeWebMonitorCallback} from './monitor-wrapper'

describe('createSafeNativeMonitorCallback', () => {
  it('calls callback with non-null value when no error', () => {
    const callback = vi.fn()
    const onError = vi.fn()
    const safe = createSafeNativeMonitorCallback('dev-1', 'notify', callback, onError)

    safe(null, {value: 'hello'})

    expect(callback).toHaveBeenCalledWith({value: 'hello'})
    expect(onError).not.toHaveBeenCalled()
  })

  it('ignores null values', () => {
    const callback = vi.fn()
    const onError = vi.fn()
    const safe = createSafeNativeMonitorCallback('dev-1', 'notify', callback, onError)

    safe(null, null)

    expect(callback).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('calls onError when monitor reports an error', () => {
    const callback = vi.fn()
    const onError = vi.fn()
    const safe = createSafeNativeMonitorCallback('dev-1', 'notify', callback, onError)

    const bleError = new Error('BLE disconnected')
    safe(bleError, null)

    expect(callback).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(bleError, {deviceId: 'dev-1', characteristic: 'notify'})
  })

  it('catches and reports callback exceptions', () => {
    const error = new Error('callback boom')
    const callback = vi.fn(() => {
      throw error
    })
    const onError = vi.fn()
    const safe = createSafeNativeMonitorCallback('dev-1', 'battery', callback, onError)

    // Should not throw
    safe(null, {value: 'data'})

    expect(callback).toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(error, {deviceId: 'dev-1', characteristic: 'battery'})
  })

  it('prioritizes monitor error over value', () => {
    const callback = vi.fn()
    const onError = vi.fn()
    const safe = createSafeNativeMonitorCallback('dev-1', 'push', callback, onError)

    const bleError = new Error('error')
    safe(bleError, {value: 'data'})

    expect(callback).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalled()
  })
})

describe('createSafeWebMonitorCallback', () => {
  it('calls callback with value', () => {
    const callback = vi.fn()
    const onError = vi.fn()
    const safe = createSafeWebMonitorCallback('dev-1', 'notify', callback, onError)

    safe('hello')

    expect(callback).toHaveBeenCalledWith('hello')
    expect(onError).not.toHaveBeenCalled()
  })

  it('catches and reports callback exceptions', () => {
    const error = new Error('callback boom')
    const callback = vi.fn(() => {
      throw error
    })
    const onError = vi.fn()
    const safe = createSafeWebMonitorCallback('dev-1', 'notify', callback, onError)

    // Should not throw
    safe('data')

    expect(callback).toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(error, {deviceId: 'dev-1', characteristic: 'notify'})
  })
})
