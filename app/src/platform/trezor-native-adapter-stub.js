/**
 * Metro stub for the Trezor-native USB/Web-BLE-bridge transport adapter.
 *
 * `@pnyx/hardware`'s service dynamically `import()`s
 * `trezor-native/transport/adapter` on its USB / extension-bridge connect
 * branches. Those transports are extension/web-only — on mobile the device
 * connects over BLE and that branch never executes. Metro, however, tries to
 * statically resolve the dynamic-import literal at bundle time (and the built
 * specifier is malformed), so we redirect it to this stub for the native
 * bundle. `createTransportAdapter` throws if ever called — a fail-fast guard
 * that never fires on mobile.
 */
export const createTransportAdapter = () => {
  throw new Error('Trezor USB/bridge transport is not available on this platform (mobile uses BLE)')
}
