/**
 * Transport and USB constants.
 *
 * Replaces @trezor/transport/lib/constants.
 *
 * @module
 */

// --- USB constants ---

export const CONFIGURATION_ID = 1
export const INTERFACE_ID = 0
export const ENDPOINT_ID = 1
export const DEBUGLINK_INTERFACE_ID = 1
export const DEBUGLINK_ENDPOINT_ID = 2
export const T1_HID_VENDOR = 0x534c
export const T1_HID_PRODUCT = 0x0001
export const WEBUSB_BOOTLOADER_PRODUCT = 0x53c0

export const TREZOR_USB_DESCRIPTORS = [
  {vendorId: 0x534c, productId: 0x0001},
  {vendorId: 0x1209, productId: 0x53c0},
  {vendorId: 0x1209, productId: 0x53c1},
] as const

// --- Timeout ---

/** How long a single transport action is allowed to take (ms). */
export const ACTION_TIMEOUT = 10_000

// --- Transport event / message names ---

export const TRANSPORT = {
  // Events
  START: 'transport-start',
  ERROR: 'transport-error',
  STOPPED: 'transport-stopped',
  DEVICE_CONNECTED: 'transport-device_connected',
  DEVICE_DISCONNECTED: 'transport-device_disconnected',
  DEVICE_SESSION_CHANGED: 'transport-device_session_changed',
  DEVICE_REQUEST_RELEASE: 'transport-device_request_release',
  SEND_MESSAGE_PROGRESS: 'transport-send_message_progress',
  TREZOR_PUSH_NOTIFICATION: 'trezor-push-notification',
  BATTERY_LEVEL: 'battery-level',
  // Messages
  DISABLE_WEBUSB: 'transport-disable_webusb',
  REQUEST_DEVICE: 'transport-request_device',
  GET_INFO: 'transport-get_info',
  SET_TRANSPORTS: 'transport-set_transports',
} as const

// --- Device type enum ---

export const DEVICE_TYPE = {
  TypeT1Hid: 0,
  TypeT1Webusb: 1,
  TypeT1WebusbBoot: 2,
  TypeT2: 3,
  TypeT2Boot: 4,
  TypeEmulator: 5,
  TypeBluetooth: 6,
} as const
