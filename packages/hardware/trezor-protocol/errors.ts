/**
 * Transport and protocol error constants.
 *
 * Replaces @trezor/transport/lib/errors and @trezor/protocol errors.
 *
 * @module
 */

// --- Transport errors (from @trezor/transport) ---

export const INTERFACE_UNABLE_TO_OPEN_DEVICE = 'Unable to open device'
export const INTERFACE_UNABLE_TO_CLOSE_DEVICE = 'Unable to close device'
export const INTERFACE_DATA_TRANSFER = 'A transfer error has occurred.'
export const DEVICE_NOT_FOUND = 'Device not found'
export const DEVICE_UNREADABLE = 'Device unreadable'
export const SESSION_WRONG_PREVIOUS = 'wrong previous session'
export const SESSION_NOT_FOUND = 'session not found'
export const SESSION_BACKGROUND_TIMEOUT = 'Sessions background did not respond in time'
export const ALREADY_LISTENING = 'Already listening'
export const NATIVE_INTERFACE_NOT_AVAILABLE = 'Interface not available'
export const WRONG_RESULT_TYPE = 'Wrong result type'
export const WRONG_ENVIRONMENT = 'Transport cannot be used in this environment'
export const DEVICE_DISCONNECTED_DURING_ACTION = 'Device disconnected during action'
export const OTHER_CALL_IN_PROGRESS = 'Other call in progress'
export const HTTP_ERROR = 'Network request failed'
export const API_DISCONNECTED = 'Api disconnected'
export const UNEXPECTED_ERROR = 'unexpected error'
export const ABORTED_BY_SIGNAL = 'Aborted by signal'
export const ABORTED_BY_TIMEOUT = 'Aborted by timeout'
export const LIBUSB_ERROR_ACCESS = 'LIBUSB_ERROR_ACCESS'
export const THP_STATE_ERROR = 'Missing THP state'

// --- Protocol errors (from @trezor/protocol) ---

export const PROTOCOL_MALFORMED = 'Malformed protocol format'
export const PROTOCOL_MISMATCH_VERSION = 'Protocol mismatch version'
