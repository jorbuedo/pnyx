/**
 * Platform-specific utilities.
 *
 * @module
 */

export type {BluetoothNotReadyReason, BluetoothState} from './bluetooth-state'
export {
  BluetoothNotReadyError,
  classifyBluetoothState,
  getBleManager,
  getBluetoothState,
  isBluetoothNotReadyError,
  subscribeBluetoothState,
  waitForBluetoothReady,
} from './bluetooth-state'
export {osShowsClipboardToast} from './clipboard-toast'
export {isNative, platformIsAndroid, platformIsIOS, platformIsWeb} from './detect'
export {
  addBroadcastListener,
  getExtensionURL,
  isExtension,
  isExtensionDevIframe,
  isExtensionFullscreen,
  isExtensionSidePanel,
  sendMessage,
  sendMessageFireAndForget,
} from './extension/runtime'
export {
  closeFullscreen,
  closePopup,
  handoffSocialToFullscreen,
  openCurrentWindowSidePanel,
  openFullscreen,
  openFullscreenRoute,
  openSidePanel,
} from './extension/surfaces'
export {
  type BLEDevice,
  type BLEScanSubscription,
  createBLETransportFactoryForDevice,
  createLedgerTransportFactory,
  createUSBTransportFactoryForDevice,
  getAvailableTransportTypes,
  getBestTransportType,
  getHardwareCapabilities,
  getPermittedWebHIDDevices,
  getPermittedWebUSBTrezorDevices,
  type HardwarePlatformCapabilities,
  isBLEAvailable,
  isExtensionPlatform,
  isHardwareUSBSupported,
  isUSBHIDSupported,
  isWebHIDAvailable,
  listUSBDevices,
  onWebDeviceConnect,
  onWebDeviceDisconnect,
  requestBLEPermissions,
  requestWebHIDPermission,
  requestWebUSBPermissionForTrezor,
  startBLEScan,
  startHardwareUSBScan,
  startUSBScan,
  stopBLE,
  TREZOR_USB_FILTERS,
  type TransportTypeId,
  type USBDevice,
} from './hardware'
export {
  decodeLedgerUsbId,
  encodeLedgerUsbId,
  isLedgerUsbId,
  type LedgerUsbHandle,
} from './ledger-usb-device'
export {
  getNotificationsAuthorizationStatus,
  handlePushNavigation,
  registerDeviceToken,
  subscribeToUserTopic,
  triggerNotificationsPermissionModal,
  unsubscribeFromUserTopic,
  unsubscribeUserTopicForGroup,
  useRequestSystemNotifications,
} from './notification-tools'
export {deviceStorage, storage} from './storage'
