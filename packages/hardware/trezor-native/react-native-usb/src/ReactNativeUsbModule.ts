/**
 * Vendored from @trezor/react-native-usb (trezor-suite, unpublished).
 *
 * Native module declaration for the React Native USB Expo module.
 */

import type {NativeModule} from 'expo-modules-core'
import {requireNativeModule} from 'expo-modules-core'

import type {NativeDevice} from './ReactNativeUsb.types'

type DeviceEvents = {
  onDeviceConnect: (device: NativeDevice | null) => void
  onDeviceDisconnect: (device: NativeDevice | null) => void
}

declare class ReactNativeUsbModuleDeclaration extends NativeModule<DeviceEvents> {
  open: (deviceName: string) => Promise<void>
  reset: (deviceName: string) => Promise<void>
  close: (deviceName: string) => Promise<void>
  claimInterface: (deviceName: string, interfaceNumber: number) => Promise<void>
  releaseInterface: (deviceName: string, interfaceNumber: number) => Promise<void>
  transferIn: (deviceName: string, endpointNumber: number, length: number) => Promise<Uint8Array>
  transferOut: (deviceName: string, endpointNumber: number, data: Uint8Array) => Promise<void>
  setPriorityMode: (isInPriorityMode: boolean) => void
  getDevices: () => Promise<NativeDevice[]>
  listDevices: () => Promise<NativeDevice[]>
  requestPermission: (deviceName: string) => Promise<boolean>
}

export const ReactNativeUsbModule = requireNativeModule<ReactNativeUsbModuleDeclaration>('ReactNativeUsb')
