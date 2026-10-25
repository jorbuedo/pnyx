import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createBleWriteHelper} from './write-helper'

describe('createBleWriteHelper', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('prepareWrite', () => {
    it('pads short messages to 244 bytes', async () => {
      const helper = createBleWriteHelper()
      const message = new Uint8Array([1, 2, 3])

      const result = await helper.prepareWrite('device-1', message)

      expect(result.length).toBe(244)
      expect(result[0]).toBe(1)
      expect(result[1]).toBe(2)
      expect(result[2]).toBe(3)
      // Rest should be zeros
      for (let i = 3; i < 244; i++) {
        expect(result[i]).toBe(0)
      }
    })

    it('preserves messages that are already 244 bytes', async () => {
      const helper = createBleWriteHelper()
      const message = new Uint8Array(244).fill(0xab)

      const result = await helper.prepareWrite('device-1', message)

      expect(result.length).toBe(244)
      expect(result.every((b) => b === 0xab)).toBe(true)
    })

    it('preserves messages longer than 244 bytes', async () => {
      const helper = createBleWriteHelper()
      const message = new Uint8Array(300).fill(0xcd)

      const result = await helper.prepareWrite('device-1', message)

      expect(result.length).toBe(300)
      expect(result.every((b) => b === 0xcd)).toBe(true)
    })

    it('pads 9-byte ACK frames to 244 bytes', async () => {
      const helper = createBleWriteHelper()
      const ackFrame = new Uint8Array(9).fill(0xff)

      const result = await helper.prepareWrite('device-1', ackFrame)

      expect(result.length).toBe(244)
      for (let i = 0; i < 9; i++) {
        expect(result[i]).toBe(0xff)
      }
      for (let i = 9; i < 244; i++) {
        expect(result[i]).toBe(0)
      }
    })

    it('throttles consecutive writes to enforce 10ms minimum gap', async () => {
      const helper = createBleWriteHelper()
      const message = new Uint8Array([1])

      // First write — no throttle
      const p1 = helper.prepareWrite('device-1', message)
      await vi.advanceTimersByTimeAsync(0)
      await p1

      // Second write immediately — should delay
      const p2 = helper.prepareWrite('device-1', message)
      // Advance by 10ms to let the throttle resolve
      await vi.advanceTimersByTimeAsync(10)
      await p2
    })

    it('does not throttle writes to different devices', async () => {
      const helper = createBleWriteHelper()
      const message = new Uint8Array([1])

      await helper.prepareWrite('device-1', message)
      // Different device — no throttle needed
      const result = await helper.prepareWrite('device-2', message)
      expect(result.length).toBe(244)
    })
  })

  describe('clearDevice', () => {
    it('clears throttle state for a device', async () => {
      const helper = createBleWriteHelper()
      const message = new Uint8Array([1])

      await helper.prepareWrite('device-1', message)
      helper.clearDevice('device-1')
      // After clearing, should not throttle
      const result = await helper.prepareWrite('device-1', message)
      expect(result.length).toBe(244)
    })
  })
})
