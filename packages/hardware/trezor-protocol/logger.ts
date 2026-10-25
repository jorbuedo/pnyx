/**
 * The logging this layer asks for, and nothing more.
 *
 * **Structural on purpose.** `@pnyx/logger`'s `Logger` satisfies it without `trezor-protocol/`
 * depending on `@pnyx/*` — which is what keeps the protocol, THP and transport layers importable on
 * their own. See this package's README on distributing the Trezor stack independently.
 *
 * Deliberately narrower than {@link module:./types}'s `Logger`, which is the transport port and
 * carries `log`/`warn`/`error` too. Nothing here logs above debug: the protocol layer reports
 * failure by returning it, and the caller decides what is worth a line.
 *
 * @module
 */

/** Structurally satisfied by `@pnyx/logger`'s `Logger` and by `console`. */
export type ProtocolLogger = {
  readonly debug: (message: string, metadata?: Record<string, unknown>) => void
  /**
   * For a failure the protocol recovered from by doing something materially different — the
   * empty-passphrase session fallback being the case that forced this onto the type. Every
   * production injector passes a `@pnyx/logger`, which already satisfies it.
   */
  readonly warn: (message: string, metadata?: Record<string, unknown>) => void
}

/**
 * The fallback when a caller passes none.
 *
 * ⚠️ **Every production call site injects a real logger** — `trezor/device.ts` for the handshake,
 * `trezor-native/{usb/usb-device-api,transport/adapter}.ts` for `getSynchronize`. This exists so a
 * test or a bare embedding does not have to build one, not as a licence to drop the injection: a
 * swallowed rejection with no line is exactly the failure the project bans.
 */
export const noopLogger: ProtocolLogger = {debug: () => {}, warn: () => {}}
