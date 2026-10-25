/**
 * Gesture-free re-acquire of an already-authorized Ledger over WebHID/WebUSB.
 *
 * A Nano S re-enumerates its USB interface on every app switch, so the old
 * handle dies and the page must reopen the device. `Transport*.create()` falls
 * back to `requestDevice()` when `getDevices()` is momentarily empty, and
 * `requestDevice()` throws "Must be handling a user gesture" outside a click
 * handler — which is exactly where a programmatic reconnect runs. Polling
 * `getDevices()` for the already-permitted device lets the caller reopen it via
 * `Transport.open(device)` instead, with no gesture.
 *
 * @module
 */

/** Ledger USB vendor id. */
export const LEDGER_USB_VENDOR_ID = 0x2c97

type DeviceLike = {readonly vendorId: number}

type DeviceSource<D extends DeviceLike> = {
  readonly getDevices: () => Promise<ReadonlyArray<D>>
}

/**
 * Poll `source.getDevices()` until an authorized Ledger appears or the timeout
 * elapses, giving a re-enumerating device time to come back. Returns the device
 * or `null`. `now`/`sleep` are injected so the polling is unit-testable without
 * real timers.
 */
export const findAuthorizedLedgerDevice = async <D extends DeviceLike>(
  source: DeviceSource<D> | undefined | null,
  opts: {
    readonly timeoutMs: number
    readonly intervalMs?: number
    readonly now: () => number
    readonly sleep: (ms: number) => Promise<void>
  },
): Promise<D | null> => {
  if (!source) return null
  const interval = opts.intervalMs ?? 150
  const deadline = opts.now() + opts.timeoutMs
  for (;;) {
    const devices = await source.getDevices()
    const ledger = devices.find((d) => d.vendorId === LEDGER_USB_VENDOR_ID)
    if (ledger) return ledger
    if (opts.now() >= deadline) return null
    await opts.sleep(interval)
  }
}
