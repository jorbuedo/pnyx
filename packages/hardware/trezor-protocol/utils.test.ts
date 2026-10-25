/**
 * Tests for trezor-protocol utils.
 *
 * `getSynchronize` is the mutex the transport adapter uses to serialize THP (v2)
 * calls per channel: THP reads the AES-GCM send nonce at encode time and only
 * advances it after the device round-trip, so two overlapping calls on one
 * channel must not run concurrently or they reuse the same (key, IV).
 *
 * @module
 */

import {describe, expect, it} from 'vitest'
import {getSynchronize} from './utils.js'

describe('getSynchronize', () => {
  it('runs queued actions strictly sequentially, never overlapping', async () => {
    const synchronize = getSynchronize()
    const events: string[] = []
    const action = (id: string, delayMs: number) => () =>
      new Promise<void>((resolve) => {
        events.push(`start-${id}`)
        setTimeout(() => {
          events.push(`end-${id}`)
          resolve()
        }, delayMs)
      })

    // B is queued while A (slower) is still running — B must wait for A to finish,
    // even though B would resolve first if allowed to run concurrently.
    const a = synchronize(action('A', 30))
    const b = synchronize(action('B', 1))
    await Promise.all([a, b])

    expect(events).toEqual(['start-A', 'end-A', 'start-B', 'end-B'])
  })

  it('keeps serializing after an action rejects', async () => {
    const synchronize = getSynchronize()
    const events: string[] = []

    const a = synchronize(async () => {
      events.push('A')
      throw new Error('boom')
    }).catch(() => {})
    const b = synchronize(async () => {
      events.push('B')
    })
    await Promise.all([a, b])

    expect(events).toEqual(['A', 'B'])
  })

  it('propagates each action’s result/error to its own caller', async () => {
    const synchronize = getSynchronize()
    await expect(synchronize(async () => 42)).resolves.toBe(42)
    await expect(synchronize(async () => Promise.reject(new Error('nope')))).rejects.toThrow('nope')
  })
})
