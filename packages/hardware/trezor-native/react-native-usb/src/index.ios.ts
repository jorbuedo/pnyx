/**
 * Vendored from @trezor/react-native-usb (trezor-suite, unpublished).
 *
 * iOS stub — USB host mode is not supported on iOS.
 * Exports matching the Android module for platform-agnostic imports.
 */

import type {EventSubscription} from 'expo-modules-core'

import type {OnConnectEvent, WebUSBDevice} from './ReactNativeUsb.types'

export const setPriorityMode = (_isInPriorityMode: boolean) => {}

export const onDeviceConnected = (_listener: (event: OnConnectEvent) => void): EventSubscription => ({
  remove: () => {},
})

export const onDeviceDisconnect = (_listener: (event: OnConnectEvent) => void): EventSubscription => ({
  remove: () => {},
})

export const getDevices = async (): Promise<WebUSBDevice[]> => []

export const listDevices = async (): Promise<WebUSBDevice[]> => []

export const requestPermission = async (_deviceName: string): Promise<boolean> => false
