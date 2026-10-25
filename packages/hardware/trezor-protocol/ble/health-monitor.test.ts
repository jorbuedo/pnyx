import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createHealthMonitor} from './health-monitor'

describe('createHealthMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires onStale after threshold with no activity', () => {
    const onStale = vi.fn()
    const monitor = createHealthMonitor({staleThresholdMs: 1000, onStale})

    monitor.recordActivity('dev-1')

    // Advance past threshold + check interval
    vi.advanceTimersByTime(6000)

    expect(onStale).toHaveBeenCalledWith('dev-1')
    monitor.dispose()
  })

  it('does not fire onStale if activity is recorded within threshold', () => {
    const onStale = vi.fn()
    const monitor = createHealthMonitor({staleThresholdMs: 10_000, onStale})

    monitor.recordActivity('dev-1')
    vi.advanceTimersByTime(5000)
    monitor.recordActivity('dev-1')
    vi.advanceTimersByTime(5000)
    monitor.recordActivity('dev-1')
    vi.advanceTimersByTime(5000)

    expect(onStale).not.toHaveBeenCalled()
    monitor.dispose()
  })

  it('removes device from tracking on removeDevice', () => {
    const onStale = vi.fn()
    const monitor = createHealthMonitor({staleThresholdMs: 1000, onStale})

    monitor.recordActivity('dev-1')
    monitor.removeDevice('dev-1')

    vi.advanceTimersByTime(6000)

    expect(onStale).not.toHaveBeenCalled()
    monitor.dispose()
  })

  it('tracks multiple devices independently', () => {
    const onStale = vi.fn()
    const monitor = createHealthMonitor({staleThresholdMs: 10_000, onStale})

    monitor.recordActivity('dev-1')
    monitor.recordActivity('dev-2')

    // Keep dev-2 alive but let dev-1 go stale
    vi.advanceTimersByTime(5000)
    monitor.recordActivity('dev-2')
    vi.advanceTimersByTime(5000)
    monitor.recordActivity('dev-2')

    // dev-1 hasn't been active for 10s, should be stale
    // dev-2 was refreshed, should still be active
    vi.advanceTimersByTime(5000)

    expect(onStale).toHaveBeenCalledWith('dev-1')
    expect(onStale).not.toHaveBeenCalledWith('dev-2')
    monitor.dispose()
  })

  it('stops interval when all devices are removed', () => {
    const onStale = vi.fn()
    const monitor = createHealthMonitor({staleThresholdMs: 1000, onStale})

    monitor.recordActivity('dev-1')
    monitor.removeDevice('dev-1')

    // Should not keep running
    vi.advanceTimersByTime(60_000)

    expect(onStale).not.toHaveBeenCalled()
    monitor.dispose()
  })

  it('dispose cleans up everything', () => {
    const onStale = vi.fn()
    const monitor = createHealthMonitor({staleThresholdMs: 1000, onStale})

    monitor.recordActivity('dev-1')
    monitor.dispose()

    vi.advanceTimersByTime(60_000)

    expect(onStale).not.toHaveBeenCalled()
  })
})
