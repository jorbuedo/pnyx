/**
 * USB device API for Trezor USB transport.
 *
 * Factory function replacing @trezor/transport's UsbApi class.
 * Provides USB communication via a WebUSB-compatible interface,
 * with device filtering, retry logic, and synchronized reset.
 */

import {DEVICE_TYPE} from '../../trezor-protocol/constants'
import * as ERRORS from '../../trezor-protocol/errors'
import {PathInternal} from '../../trezor-protocol/types'
import {arrayPartition, createDeferred, getSynchronize, resolveAfter} from '../../trezor-protocol/utils'
import {createEventEmitter} from '../event-emitter'

import type {DeviceApi, ErrorResult, Logger} from '../transport/types'
import {error, success, unknownError} from '../transport/types'
import {
  CONFIGURATION_ID,
  DEBUGLINK_ENDPOINT_ID,
  DEBUGLINK_INTERFACE_ID,
  ENDPOINT_ID,
  INTERFACE_ID,
  T1_HID_PRODUCT,
  T1_HID_VENDOR,
  TREZOR_USB_DESCRIPTORS,
  WEBUSB_BOOTLOADER_PRODUCT,
} from './constants'
import type {WebUSBInterface} from './web-usb'

/**
 * Subset of the WebUSB device interface used by this transport.
 * Matches the WebUSBDevice type from react-native-usb.
 */
type UsbDevice = {
  readonly vendorId: number
  readonly productId: number
  readonly deviceVersionMajor: number
  readonly deviceVersionMinor?: number
  readonly productName?: string
  readonly manufacturerName?: string
  readonly serialNumber?: string
  readonly opened: boolean
  readonly configuration?: {
    readonly configurationValue: number
    readonly interfaces: ReadonlyArray<{readonly interfaceNumber: number; readonly claimed?: boolean}>
  }
  readonly configurations: unknown[]
  open: () => Promise<void>
  close: () => Promise<void>
  reset: () => Promise<void>
  selectConfiguration: (configurationValue: number) => Promise<void>
  claimInterface: (interfaceNumber: number) => Promise<void>
  releaseInterface: (interfaceNumber: number) => Promise<void>
  transferIn: (
    endpointNumber: number,
    length: number,
  ) => Promise<{status: string; data?: {byteLength: number; buffer: ArrayBuffer}}>
  transferOut: (endpointNumber: number, data: Uint8Array) => Promise<{status: string}>
}

type TransportInterfaceDevice = {
  path: string
  device: UsbDevice
}

const formatDeviceForLog = (device: UsbDevice) =>
  JSON.stringify({
    productName: device.productName,
    manufacturerName: device.manufacturerName,
    serialNumber: device.serialNumber,
    vendorId: device.vendorId,
    productId: device.productId,
    deviceVersionMajor: device.deviceVersionMajor,
    deviceVersionMinor: device.deviceVersionMinor,
    opened: device.opened,
  })

const matchDeviceType = (device: UsbDevice) => {
  const isBootloader = device.productId === WEBUSB_BOOTLOADER_PRODUCT
  if (device.deviceVersionMajor === 2) {
    return isBootloader ? DEVICE_TYPE.TypeT2Boot : DEVICE_TYPE.TypeT2
  }
  if (isBootloader) return DEVICE_TYPE.TypeT1WebusbBoot
  if (device.vendorId === T1_HID_VENDOR && device.productId === T1_HID_PRODUCT) return DEVICE_TYPE.TypeT1Hid
  return DEVICE_TYPE.TypeT1Webusb
}

const filterDevices = (devices: UsbDevice[]): [UsbDevice[], UsbDevice[]] => {
  const trezorDevices = devices.filter((dev) =>
    TREZOR_USB_DESCRIPTORS.some(
      (desc: {vendorId: number; productId: number}) =>
        dev.vendorId === desc.vendorId && dev.productId === desc.productId,
    ),
  )
  return arrayPartition(trezorDevices, (device) => device.vendorId === T1_HID_VENDOR) as [UsbDevice[], UsbDevice[]]
}

const isInterfaceClaimed = (device: UsbDevice, interfaceId: number) =>
  device.configuration?.interfaces.find((i) => i.interfaceNumber === interfaceId)?.claimed

type ReadWriteErrorCode =
  | typeof ERRORS.DEVICE_NOT_FOUND
  | typeof ERRORS.INTERFACE_DATA_TRANSFER
  | typeof ERRORS.DEVICE_DISCONNECTED_DURING_ACTION
  | typeof ERRORS.UNEXPECTED_ERROR
  | typeof ERRORS.ABORTED_BY_SIGNAL
  | typeof ERRORS.ABORTED_BY_TIMEOUT

const handleReadWriteError = (err: unknown, logger?: Logger): ErrorResult<ReadWriteErrorCode> => {
  const message = err instanceof Error ? err.message : String(err)
  const disconnectedErrors = [
    'LIBUSB_TRANSFER_ERROR',
    'LIBUSB_ERROR_PIPE',
    'LIBUSB_ERROR_IO',
    'LIBUSB_ERROR_NO_DEVICE',
    'LIBUSB_ERROR_OTHER',
    ERRORS.INTERFACE_DATA_TRANSFER,
    'The device was disconnected.',
  ]
  if (disconnectedErrors.some((e) => message.includes(e))) {
    return error(ERRORS.DEVICE_DISCONNECTED_DURING_ACTION)
  }
  logger?.error('usb: unexpected error:', err)
  return unknownError(err, [
    ERRORS.DEVICE_NOT_FOUND,
    ERRORS.DEVICE_DISCONNECTED_DURING_ACTION,
    ERRORS.ABORTED_BY_TIMEOUT,
    ERRORS.ABORTED_BY_SIGNAL,
    ERRORS.UNEXPECTED_ERROR,
  ]) as ErrorResult<ReadWriteErrorCode>
}

export type UsbDeviceApi = DeviceApi

export const createUsbDeviceApi = (params: {
  usbInterface: WebUSBInterface
  logger?: Logger | undefined
  debugLink?: boolean | undefined
}): UsbDeviceApi => {
  const {usbInterface, logger, debugLink} = params
  const emitter = createEventEmitter()
  let devices: TransportInterfaceDevice[] = []
  const deviceResetMap: Record<string, boolean> = {}
  const devicePendingTransferIn = new Map<
    UsbDevice,
    Promise<{status: string; data?: {byteLength: number; buffer: ArrayBuffer}}>
  >()
  const abortController = new AbortController()

  const synchronizeCreateDevices = getSynchronize(logger)
  const synchronizeGetDevices = getSynchronize(logger)
  const synchronizeResetDevice = getSynchronize(logger)

  const findDevice = (path: string): UsbDevice | undefined => {
    const entry = devices.find((d) => d.path === path)
    return entry?.device
  }

  const devicesToDescriptors = () =>
    devices.map((d) => ({
      path: PathInternal(d.path),
      type: matchDeviceType(d.device),
      product: d.device.productId,
      vendor: d.device.vendorId,
      id: d.device.serialNumber,
      apiType: 'usb' as const,
    }))

  const abortableMethod = <T>(
    method: () => Promise<T>,
    opts: {signal?: AbortSignal | undefined; onAbort?: (() => Promise<void>) | undefined},
  ): Promise<T> => {
    const {signal, onAbort} = opts
    if (!signal) return method()
    if (signal.aborted) return Promise.reject(new Error(ERRORS.ABORTED_BY_SIGNAL))

    const dfd = createDeferred<T>()
    const abortListener = async () => {
      logger?.debug('usb: abortableMethod onAbort start')
      try {
        await onAbort?.()
      } catch (e: unknown) {
        // Cleanup must not throw out of an abort handler, but a cleanup that never completes
        // leaves the device in whatever state the abort found it.
        logger?.debug(`usb: abortableMethod onAbort threw: ${String(e)}`)
      }
      logger?.debug('usb: abortableMethod onAbort done')
      dfd.reject(new Error(ERRORS.ABORTED_BY_SIGNAL))
    }
    signal.addEventListener('abort', abortListener)
    if (signal.aborted) abortController.abort(signal.reason)

    const methodPromise = method().catch((methodError) => {
      logger?.debug(`usb: abortableMethod method() aborted: ${signal.aborted} ${methodError}`)
      if (signal.aborted) return dfd.promise
      dfd.reject(methodError)
      throw methodError
    })

    return Promise.race([methodPromise, dfd.promise])
      .then((r) => {
        dfd.resolve(r)
        return r
      })
      .finally(() => {
        signal.removeEventListener('abort', abortListener)
      })
  }

  const resetDevice = async (path: string) => {
    const device = findDevice(path)
    if (!device) {
      logger?.debug('usb: resetDevice: device not found')
      return
    }
    if (deviceResetMap[path]) {
      logger?.debug('usb: resetDevice: device reset already running')
      return
    }
    deviceResetMap[path] = true
    try {
      logger?.debug('usb: resetDevice: device.reset')
      await synchronizeResetDevice(() => device.reset())
      logger?.debug('usb: resetDevice: device.reset done')
    } catch (err: unknown) {
      logger?.error(`usb: resetDevice: device.reset error: ${err instanceof Error ? err.message : err}`)
    } finally {
      delete deviceResetMap[path]
    }
  }

  const createDevices = (rawDevices: UsbDevice[], _signal?: AbortSignal) =>
    synchronizeCreateDevices(async () => {
      let bootloaderId = 0
      const getPathFromUsbDevice = (device: UsbDevice) => {
        const {serialNumber} = device
        let path = serialNumber == null || serialNumber === '' ? 'bootloader' : serialNumber
        if (path === 'bootloader') {
          logger?.debug('usb: device without serial number!')
          bootloaderId++
          path += bootloaderId
        }
        return path
      }

      const [hidDevices, nonHidDevices] = filterDevices(rawDevices)
      const loadedDevices = await Promise.all(
        nonHidDevices.map(async (device) => {
          logger?.debug(`usb: creating device ${formatDeviceForLog(device)}`)
          const path = getPathFromUsbDevice(device)
          return {path, device}
        }),
      )
      return [...loadedDevices, ...hidDevices.map((d) => ({path: getPathFromUsbDevice(d), device: d}))]
    })

  const getTransferIn = (device: UsbDevice) => {
    let pending = devicePendingTransferIn.get(device)
    if (!pending) {
      pending = device
        .transferIn(debugLink ? DEBUGLINK_ENDPOINT_ID : ENDPOINT_ID, 64)
        .finally(() => devicePendingTransferIn.delete(device))
      devicePendingTransferIn.set(device, pending)
    }
    return pending
  }

  const enumerate: DeviceApi['enumerate'] = async (signal?) => {
    try {
      logger?.debug('usb: enumerate')
      const rawDevices = await abortableMethod(
        () => synchronizeGetDevices(() => usbInterface.getDevices()) as Promise<UsbDevice[]>,
        {signal},
      )
      devices = await createDevices(rawDevices)
      return success(devicesToDescriptors())
    } catch (err) {
      return error(ERRORS.UNEXPECTED_ERROR, err instanceof Error ? err.message : String(err))
    }
  }

  const listen: DeviceApi['listen'] = () => {
    usbInterface.onconnect = async (event) => {
      const device = event.device as unknown as UsbDevice | undefined
      if (!device) return
      logger?.debug(`usb: onconnect: ${formatDeviceForLog(device)}`)
      if (device.opened) {
        logger?.debug('usb: onconnect: device already opened, closing')
        await device.close()
      }
      try {
        const newDevices = await createDevices([device], abortController.signal)
        devices = [...devices, ...newDevices]
        emitter.emit('transport-interface-change', devicesToDescriptors())
      } catch (err: unknown) {
        logger?.error(`usb: createDevices error: ${err instanceof Error ? err.message : err}`)
      }
    }
    usbInterface.ondisconnect = (event) => {
      const device = event.device as unknown as UsbDevice | undefined
      if (!device) return
      if (!device.serialNumber) {
        logger?.debug(
          `usb: ondisconnect: device without serial number:, ${device.productName}, ${device.manufacturerName}`,
        )
        enumerate()
        return
      }
      const index = devices.findIndex((d) => d.path === device.serialNumber)
      if (index > -1) {
        devices.splice(index, 1)
        emitter.emit('transport-interface-change', devicesToDescriptors())
      } else {
        logger?.error('usb: device that should be removed does not exist in state')
      }
    }
  }

  const read: DeviceApi['read'] = async (path, signal?) => {
    const device = findDevice(path)
    if (!device) return error(ERRORS.DEVICE_NOT_FOUND)

    try {
      logger?.debug('usb: device.transferIn')
      const res = await abortableMethod(() => getTransferIn(device), {
        signal,
        onAbort: () => resetDevice(path),
      })
      logger?.debug(`usb: device.transferIn done. status: ${res.status}, byteLength: ${res.data?.byteLength}.`)
      if (!res.data?.byteLength) {
        logger?.warn('usb: device.transferIn error: empty data buffer')
        return success(new Uint8Array(0))
      }
      return success(new Uint8Array(res.data.buffer))
    } catch (err) {
      logger?.error(`usb: device.transferIn error ${err}`)
      return handleReadWriteError(err, logger)
    }
  }

  const write: DeviceApi['write'] = async (path, buffer, signal?) => {
    const device = findDevice(path)
    if (!device) return error(ERRORS.DEVICE_NOT_FOUND)

    const newArray = new Uint8Array(64)
    newArray.set(new Uint8Array(buffer))
    const timeout = setTimeout(() => {
      logger?.debug('usb: device.transfer out take suspiciously long. timing out.')
      resetDevice(path).catch((e) => {
        logger?.warn(`usb: reset after a slow transferOut failed: ${String(e)}`)
      })
    }, 1000)

    try {
      logger?.debug('usb: device.transferOut')
      const result = await abortableMethod(
        () => device.transferOut(debugLink ? DEBUGLINK_ENDPOINT_ID : ENDPOINT_ID, newArray),
        {signal, onAbort: () => resetDevice(path)},
      )
      logger?.debug('usb: device.transferOut done.')
      if (result.status !== 'ok') {
        logger?.error(`usb: device.transferOut status not ok: ${result.status}`)
        return error(ERRORS.INTERFACE_DATA_TRANSFER, `transfer out status not ok: ${result.status}`)
      }
      return success(undefined)
    } catch (err) {
      return handleReadWriteError(err, logger)
    } finally {
      clearTimeout(timeout)
    }
  }

  const openInternal = async (path: string, opts: {reset: boolean; signal?: AbortSignal | undefined}) => {
    const device = findDevice(path)
    if (!device) return error(ERRORS.INTERFACE_UNABLE_TO_OPEN_DEVICE)

    try {
      logger?.debug('usb: device.open')
      await abortableMethod(() => device.open(), {signal: opts.signal})
      logger?.debug(`usb: device.open done. device: ${formatDeviceForLog(device)}`)
    } catch (err: unknown) {
      logger?.error(`usb: device.open error ${err}`)
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('LIBUSB_ERROR_ACCESS')) {
        return error(ERRORS.LIBUSB_ERROR_ACCESS)
      }
      return error(ERRORS.INTERFACE_UNABLE_TO_OPEN_DEVICE, msg)
    }

    if (device.configuration?.configurationValue !== CONFIGURATION_ID) {
      try {
        logger?.debug(`usb: device.selectConfiguration ${CONFIGURATION_ID}`)
        await abortableMethod(() => device.selectConfiguration(CONFIGURATION_ID), {signal: opts.signal})
        logger?.debug(`usb: device.selectConfiguration done: ${CONFIGURATION_ID}.`)
      } catch (err: unknown) {
        logger?.error(`usb: device.selectConfiguration error ${err}. device: ${formatDeviceForLog(device)}`)
      }
    }

    if (opts.reset) {
      try {
        logger?.debug('usb: device.reset')
        await resetDevice(path)
        logger?.debug('usb: device.reset done.')
      } catch (err: unknown) {
        logger?.error(`usb: device.reset error ${err}. device: ${formatDeviceForLog(device)}`)
      }
    }

    const interfaceId = debugLink ? DEBUGLINK_INTERFACE_ID : INTERFACE_ID
    if (!isInterfaceClaimed(device, interfaceId)) {
      try {
        logger?.debug(`usb: device.claimInterface: ${interfaceId}`)
        await abortableMethod(() => device.claimInterface(interfaceId), {signal: opts.signal})
        logger?.debug(`usb: device.claimInterface done: ${interfaceId}.`)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger?.error(`usb: device.claimInterface error ${err}.`)
        return error(ERRORS.INTERFACE_UNABLE_TO_OPEN_DEVICE, msg)
      }
    }

    return success(undefined)
  }

  const openDevice: DeviceApi['openDevice'] = async (path, options?) => {
    const reset = !!options?.reset
    const signal = options?.signal
    for (let i = 0; i < 5; i++) {
      logger?.debug(`usb: openDevice attempt ${i}`)
      const res = await openInternal(path, {reset, signal})
      if (res.success || signal?.aborted) return res
      await resolveAfter(100 * i)
    }
    return openInternal(path, {reset, signal})
  }

  const closeDevice: DeviceApi['closeDevice'] = async (path) => {
    let device = findDevice(path)
    if (!device) return error(ERRORS.DEVICE_NOT_FOUND)

    logger?.debug(`usb: closeDevice. device.opened: ${device.opened}`)
    if (device.opened && !debugLink) {
      try {
        await resetDevice(path)
      } catch (err: unknown) {
        logger?.error(`usb: device.reset error ${err}. device: ${formatDeviceForLog(device)}`)
      }
    }

    device = findDevice(path)
    const interfaceId = debugLink ? DEBUGLINK_INTERFACE_ID : INTERFACE_ID
    if (device?.opened && isInterfaceClaimed(device, interfaceId)) {
      const devForRelease = device
      try {
        logger?.debug(`usb: device.releaseInterface: ${interfaceId}`)
        await synchronizeResetDevice(() => devForRelease.releaseInterface(interfaceId))
        logger?.debug(`usb: device.releaseInterface done: ${interfaceId}.`)
      } catch (err: unknown) {
        logger?.error(`usb: releaseInterface error ${err}.`)
      }
    }

    device = findDevice(path)
    if (device?.opened) {
      const devForClose = device
      try {
        logger?.debug('usb: device.close')
        await synchronizeResetDevice(() => devForClose.close())
        logger?.debug('usb: device.close done.')
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger?.debug(`usb: device.close error ${err}.`)
        return error(ERRORS.INTERFACE_UNABLE_TO_CLOSE_DEVICE, msg)
      }
    }

    return success(undefined)
  }

  const dispose: DeviceApi['dispose'] = () => {
    usbInterface.onconnect = null
    usbInterface.ondisconnect = null
    abortController.abort()
  }

  return {
    type: 'usb',
    chunkSize: 64,
    enumerate,
    listen,
    read,
    write,
    openDevice,
    closeDevice,
    dispose,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
  }
}
