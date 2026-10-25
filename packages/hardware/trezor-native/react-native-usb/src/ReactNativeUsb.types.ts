/**
 * Vendored from @trezor/react-native-usb (trezor-suite, unpublished).
 *
 * Types for the React Native USB Expo module.
 */

type USBConfiguration = unknown
type USBControlTransferParameters = unknown
type USBInTransferResult = unknown
type USBOutTransferResult = unknown
type USBDirection = unknown
type USBIsochronousInTransferResult = unknown
type USBIsochronousOutTransferResult = unknown

export interface NativeDevice {
  readonly deviceClass: number
  readonly deviceSubclass: number
  readonly deviceProtocol: number
  readonly vendorId: number
  readonly productId: number
  readonly manufacturerName?: string | undefined
  readonly productName?: string | undefined
  readonly serialNumber?: string | undefined
  readonly opened: boolean
  /** Android device path — unique per USB port */
  readonly deviceName: string
  /**
   * Whether this app currently holds USB permission for the device. Only
   * `listDevices()` returns unpermitted entries; `getDevices()` filters them out.
   */
  readonly hasPermission?: boolean | undefined
}

export interface WebUSBDevice {
  readonly usbVersionMajor: number
  readonly usbVersionMinor: number
  readonly usbVersionSubminor: number
  readonly deviceClass: number
  readonly deviceSubclass: number
  readonly deviceProtocol: number
  readonly vendorId: number
  readonly productId: number
  readonly deviceVersionMajor: number
  readonly deviceVersionMinor: number
  readonly deviceVersionSubminor: number
  readonly manufacturerName?: string | undefined
  readonly productName?: string | undefined
  readonly serialNumber?: string | undefined
  readonly configuration?: USBConfiguration | undefined
  readonly configurations: USBConfiguration[]
  readonly opened: boolean
  /** Android device path — spread in from `NativeDevice`, addresses the port. */
  readonly deviceName: string
  readonly hasPermission?: boolean | undefined
  open(): Promise<void>
  reset(): Promise<void>
  close(): Promise<void>
  forget(): Promise<void>
  selectConfiguration(configurationValue: number): Promise<void>
  claimInterface(interfaceNumber: number): Promise<void>
  releaseInterface(interfaceNumber: number): Promise<void>
  selectAlternateInterface(interfaceNumber: number, alternateSetting: number): Promise<void>
  controlTransferIn(setup: USBControlTransferParameters, length: number): Promise<USBInTransferResult>
  controlTransferOut(setup: USBControlTransferParameters, data?: BufferSource): Promise<USBOutTransferResult>
  clearHalt(direction: USBDirection, endpointNumber: number): Promise<void>
  transferIn(endpointNumber: number, length: number): Promise<USBInTransferResult>
  transferOut(endpointNumber: number, data: BufferSource): Promise<USBOutTransferResult>
  isochronousTransferIn(endpointNumber: number, packetLengths: number[]): Promise<USBIsochronousInTransferResult>
  isochronousTransferOut(
    endpointNumber: number,
    data: BufferSource,
    packetLengths: number[],
  ): Promise<USBIsochronousOutTransferResult>
}

export interface OnConnectEvent extends Event {
  device: WebUSBDevice | null | undefined
}
