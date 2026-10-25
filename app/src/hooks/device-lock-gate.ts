/**
 * When a prewarmed device-lock answer may be reused.
 *
 * The probe is a native round trip, and onboarding ran it on the tap itself — so "Continue with
 * biometrics" spent that trip with nothing on screen changing. Running it when the screen appears
 * instead means the tap almost always has its answer already.
 *
 * @module
 */

export type DeviceLockDecision = {
  readonly capable: boolean
  /** The answer worth keeping for the next tap, or `null` to probe again. */
  readonly cache: Promise<boolean> | null
}

/**
 * Resolve the gate, reusing `cached` only when it is safe to.
 *
 * ⚠️ **A negative answer is never reused.** "This device has a lock" cannot become false while the
 * user sits in onboarding, so it is safe to prewarm. "This device has no lock" is precisely the
 * state the user is being sent away to change — and they come back to a screen that never
 * unmounted, so a remembered `false` would block them on the strength of a fact they had just
 * fixed. That is why this is a rule with a test and not a `??`.
 */
export const resolveDeviceLock = async (
  cached: Promise<boolean> | null,
  probe: () => Promise<boolean>,
): Promise<DeviceLockDecision> => {
  if (cached !== null && (await cached)) return {capable: true, cache: cached}
  const capable = await probe()
  return {capable, cache: capable ? Promise.resolve(true) : null}
}
