/**
 * Ledger web transports (browser/extension).
 *
 * Import this for WebHID and WebUSB transport support.
 *
 * @module
 */

export {
  createWebHIDTransport,
  createWebHIDTransportFactory,
  createWebUSBTransport,
  createWebUSBTransportFactory,
  detectBestWebTransportFactory,
  hasWebHID,
  hasWebUSB,
} from './ledger/transports-web'
