/**
 * WebSocket shim for React Native.
 *
 * The `ws` package is a Node.js WebSocket library that doesn't work in React Native.
 * However, React Native has its own global WebSocket implementation.
 *
 * This shim redirects `ws` imports to use the native WebSocket.
 *
 * @module
 */

// React Native provides a global WebSocket that is compatible with the browser API
module.exports = globalThis.WebSocket
module.exports.default = globalThis.WebSocket
module.exports.WebSocket = globalThis.WebSocket
