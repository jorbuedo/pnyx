import {describe, expect, it, vi} from 'vitest'
import {type BleManagerInterface, createBleDeviceApi} from './create-ble-device-api'

const createMockManager = (): BleManagerInterface => ({
  onDeviceConnectionStatusChange: vi.fn(() => ({remove: vi.fn()})),
  onDevicePushNotification: vi.fn(() => ({remove: vi.fn()})),
  onDeviceBatteryLevelChange: vi.fn(() => ({remove: vi.fn()})),
  getConnectedDeviceIds: vi.fn(() => ['dev-1']),
  isDeviceConnected: vi.fn((id) => id === 'dev-1'),
  read: vi.fn(async () => ({success: true as const, payload: new Uint8Array([1, 2, 3])})),
  write: vi.fn(async () => {}),
  cancelRead: vi.fn(),
})

describe('createBleDeviceApi', () => {
  it('has bluetooth type and 244 chunk size', () => {
    const api = createBleDeviceApi(createMockManager(), {})
    expect(api.type).toBe('bluetooth')
    expect(api.chunkSize).toBe(244)
  })

  it('enumerate returns connected devices', async () => {
    const manager = createMockManager()
    const api = createBleDeviceApi(manager, {})

    const result = await api.enumerate()

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.payload).toHaveLength(1)
      expect(result.payload[0]?.path).toBe('dev-1')
      expect(result.payload[0]?.type).toBe(6) // TypeBluetooth
    }
  })

  it('write passes buffer directly to manager without padding', async () => {
    const manager = createMockManager()
    const api = createBleDeviceApi(manager, {})

    const buffer = new Uint8Array([0x01, 0x02, 0x03])
    await api.write('dev-1', buffer)

    expect(manager.write).toHaveBeenCalledWith('dev-1', buffer)
    // Verify the exact buffer was passed — no 244-byte wrapper
    const passedBuffer = (manager.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as Uint8Array
    expect(passedBuffer.length).toBe(3)
  })

  it('write returns error for disconnected device', async () => {
    const manager = createMockManager()
    const api = createBleDeviceApi(manager, {})

    const result = await api.write('unknown-device', new Uint8Array([1]))

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Device not found')
    }
  })

  it('read delegates to manager', async () => {
    const manager = createMockManager()
    const api = createBleDeviceApi(manager, {})

    const result = await api.read('dev-1')

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.payload).toEqual(new Uint8Array([1, 2, 3]))
    }
  })

  it('read returns error for disconnected device', async () => {
    const manager = createMockManager()
    const api = createBleDeviceApi(manager, {})

    const result = await api.read('unknown-device')

    expect(result.success).toBe(false)
  })

  it('openDevice tracks push notification subscriptions', async () => {
    const manager = createMockManager()
    const api = createBleDeviceApi(manager, {})

    const result = await api.openDevice('dev-1', {channel: 'trezor-push-notification'})
    expect(result.success).toBe(true)
  })

  it('closeDevice cancels read for read channel', async () => {
    const manager = createMockManager()
    const api = createBleDeviceApi(manager, {})

    await api.closeDevice('dev-1', {channel: 'read'})
    expect(manager.cancelRead).toHaveBeenCalledWith('dev-1')
  })

  it('dispose removes subscriptions', () => {
    const removeFns = [vi.fn(), vi.fn(), vi.fn()]
    let callIdx = 0
    const manager: BleManagerInterface = {
      ...createMockManager(),
      // biome-ignore lint/style/noNonNullAssertion: test array is pre-populated with exactly 3 elements
      onDeviceConnectionStatusChange: vi.fn(() => ({remove: removeFns[callIdx++]!})),
      // biome-ignore lint/style/noNonNullAssertion: test array is pre-populated with exactly 3 elements
      onDevicePushNotification: vi.fn(() => ({remove: removeFns[callIdx++]!})),
      // biome-ignore lint/style/noNonNullAssertion: test array is pre-populated with exactly 3 elements
      onDeviceBatteryLevelChange: vi.fn(() => ({remove: removeFns[callIdx++]!})),
    }

    const api = createBleDeviceApi(manager, {})
    api.dispose()

    for (const fn of removeFns) {
      expect(fn).toHaveBeenCalled()
    }
  })
})
