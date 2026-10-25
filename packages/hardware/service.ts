/**
 * Hardware wallet service — device lifecycle management.
 *
 * @module
 */

export {
  createHardwareWalletService,
  HardwareWalletServiceLayer,
  HardwareWalletServiceTag,
} from './service/hardware-wallet-service'
export type {
  BLEDeviceInfo,
  BLEScanSubscription,
  ConnectedDevice,
  DetectedDevice,
  HardwareAccount,
  HardwareWalletService,
  HardwareWalletServiceConfig,
  HardwareWalletState,
  HIDDevice,
  PlatformBLEScanFn,
  TrezorUIRequest,
} from './service/types'
export type {TrezorConfig} from './types'
