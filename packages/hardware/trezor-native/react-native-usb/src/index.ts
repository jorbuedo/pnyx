/**
 * Vendored from @trezor/react-native-usb (trezor-suite, unpublished).
 *
 * Standalone functions for Android USB communication via the React Native USB
 * Expo native module. These are consumed by usb/web-usb.ts which provides
 * the WebUSB-compatible interface.
 */

import type {EventSubscription} from 'expo-modules-core'

import type {NativeDevice, OnConnectEvent, WebUSBDevice} from './ReactNativeUsb.types'
import {ReactNativeUsbModule} from './ReactNativeUsbModule'

export const setPriorityMode = (isInPriorityMode: boolean) => ReactNativeUsbModule.setPriorityMode(isInPriorityMode)

const open = (deviceName: string) => ReactNativeUsbModule.open(deviceName)

const reset = (deviceName: string) => ReactNativeUsbModule.reset(deviceName)

const close = (deviceName: string) => ReactNativeUsbModule.close(deviceName)

const claimInterface = (deviceName: string, interfaceNumber: number) =>
  ReactNativeUsbModule.claimInterface(deviceName, interfaceNumber)

const releaseInterface = (deviceName: string, interfaceNumber: number) =>
  ReactNativeUsbModule.releaseInterface(deviceName, interfaceNumber)

const transferIn = async (deviceName: string, endpointNumber: number, length: number) => {
  const data = await ReactNativeUsbModule.transferIn(deviceName, endpointNumber, length).then((result) => ({
    data: result,
    status: 'ok' as const,
  }))
  return data
}

const transferOut = async (deviceName: string, endpointNumber: number, data: Uint8Array | BufferSource) => {
  const uint8Data =
    data instanceof Uint8Array ? data : new Uint8Array(ArrayBuffer.isView(data) ? data.buffer : (data as ArrayBuffer))
  await ReactNativeUsbModule.transferOut(deviceName, endpointNumber, uint8Data)
  return {status: 'ok' as const}
}

const createNoop = (_methodName: string) => async () => {}

const createWebUSBDevice = (device: NativeDevice): WebUSBDevice => ({
  ...device,
  open: () => open(device.deviceName),
  reset: () => reset(device.deviceName),
  close: () => close(device.deviceName),
  forget: createNoop('forget'),
  selectConfiguration: createNoop('selectConfiguration'),
  claimInterface: (interfaceNumber: number) => claimInterface(device.deviceName, interfaceNumber),
  releaseInterface: (interfaceNumber: number) => releaseInterface(device.deviceName, interfaceNumber),
  selectAlternateInterface: createNoop('selectAlternateInterface'),
  controlTransferIn: createNoop('controlTransferIn'),
  controlTransferOut: createNoop('controlTransferOut'),
  clearHalt: createNoop('clearHalt'),
  transferIn: (endpointNumber: number, length: number) => transferIn(device.deviceName, endpointNumber, length),
  transferOut: (endpointNumber: number, transferData: BufferSource) =>
    transferOut(device.deviceName, endpointNumber, transferData),
  isochronousTransferIn: createNoop('isochronousTransferIn'),
  isochronousTransferOut: createNoop('isochronousTransferOut'),

  usbVersionMajor: 2,
  usbVersionMinor: 0,
  usbVersionSubminor: 0,
  deviceVersionMajor: 1,
  deviceVersionMinor: 0,
  deviceVersionSubminor: 0,
  configurations: [],
})

// Track connected devices to avoid duplicate onConnect events
const connectedDevices = new Map<string, WebUSBDevice>()

const blankEvent = {
  bubbles: false,
  cancelBubble: false,
  cancelable: false,
} as Event

export const onDeviceConnected = (listener: (event: OnConnectEvent) => void): EventSubscription =>
  ReactNativeUsbModule.addListener('onDeviceConnect', (device: NativeDevice | null) => {
    if (!device) return

    if (connectedDevices.has(device.deviceName)) return

    const webUSBDevice = createWebUSBDevice(device)
    connectedDevices.set(device.deviceName, webUSBDevice)

    const event = {device: webUSBDevice, ...blankEvent} as OnConnectEvent
    listener(event)
  })

export const onDeviceDisconnect = (listener: (event: OnConnectEvent) => void): EventSubscription =>
  ReactNativeUsbModule.addListener('onDeviceDisconnect', (device: NativeDevice | null) => {
    if (!device) return

    const webUSBDevice = createWebUSBDevice(device)
    connectedDevices.delete(device.deviceName)
    const event = {device: webUSBDevice, ...blankEvent} as OnConnectEvent
    listener(event)
  })

export const getDevices = async (): Promise<WebUSBDevice[]> => {
  const devices = await ReactNativeUsbModule.getDevices()
  return devices.map((device: NativeDevice) => createWebUSBDevice(device))
}

/** Every attached device, permitted or not — each carries `hasPermission`. */
export const listDevices = async (): Promise<WebUSBDevice[]> => {
  const devices = await ReactNativeUsbModule.listDevices()
  return devices.map((device: NativeDevice) => createWebUSBDevice(device))
}

/**
 * Prompt for USB permission on a device. Resolves `true` once granted (or
 * immediately if already held), `false` if the user denied it.
 */
export const requestPermission = (deviceName: string): Promise<boolean> =>
  ReactNativeUsbModule.requestPermission(deviceName)
