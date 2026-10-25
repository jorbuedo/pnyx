import {beforeEach, describe, expect, it, vi} from 'vitest'
import {
  __resetGateStateForTests,
  consumeGateLockRequest,
  isGateLockRequested,
  isGateOpen,
  markGateOpen,
  requestGateLock,
  subscribeGateLock,
} from './gate-state'

beforeEach(__resetGateStateForTests)

describe('gate open state', () => {
  it('starts closed and opens once a profile mounts', () => {
    expect(isGateOpen()).toBe(false)
    markGateOpen()
    expect(isGateOpen()).toBe(true)
  })

  it('a re-lock closes it again, so the deep-link buffer resumes parking', () => {
    markGateOpen()
    requestGateLock()
    expect(isGateOpen()).toBe(false)
  })
})

describe('re-lock signalling', () => {
  it('notifies subscribers', () => {
    // The gate mounts above the lock route and can never be re-mounted by it,
    // so a re-lock that does not reach here is a PIN mode that silently does
    // nothing.
    const listener = vi.fn()
    subscribeGateLock(listener)
    requestGateLock()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeGateLock(listener)
    unsubscribe()
    requestGateLock()
    expect(listener).not.toHaveBeenCalled()
  })

  it('is consumed exactly once', () => {
    requestGateLock()
    expect(isGateLockRequested()).toBe(true)
    expect(consumeGateLockRequest()).toBe(true)
    expect(consumeGateLockRequest()).toBe(false)
    expect(isGateLockRequested()).toBe(false)
  })

  it('reports nothing pending before any request', () => {
    expect(isGateLockRequested()).toBe(false)
    expect(consumeGateLockRequest()).toBe(false)
  })
})
