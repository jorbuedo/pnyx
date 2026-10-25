/**
 * Native USB transport factory for Trezor on Android.
 *
 * Replaces the NativeUsbTransport class with a factory function.
 * Wraps the vendored react-native-usb Expo module in a duck-typed
 * transport for the in-repo `trezor-protocol/` stack. There is no `@trezor/connect` here.
 *
 * USB native module imports are deferred to call-time so that importing
 * `./index.js/trezor-native` for Bluetooth-only use doesn't crash
 * when the ReactNativeUsb Expo module isn't compiled into the build.
 */

import type {TransportParams} from './transport/types'

export type {TransportParams}

export const createNativeUsbTransport = async (params: TransportParams = {}) => {
  const {createWebUSB} = await import('./usb/web-usb')
  const {createUsbDeviceApi} = await import('./usb/usb-device-api')
  const {createTransportAdapter} = await import('./transport/adapter')

  const webUsb = createWebUSB()
  const api = createUsbDeviceApi({usbInterface: webUsb, logger: params.logger})

  return createTransportAdapter({
    name: 'NativeUsbTransport',
    api,
    logger: params.logger,
    messages: params.messages,
    id: params.id,
  })
}
