/**
 * Remember a built connector — and never remember a failure.
 *
 * ⚠️ **A negative result must not be cached.** Building a connector reads a derived address out of
 * SQLite, and that read can fail for reasons that pass: a stale native handle after the Activity is
 * trimmed, a database reopening. Caching the `null` those produce turns one blip into a permanent
 * state, because every later caller is answered from the cache and the build is never attempted again.
 *
 * Measured on the emulator 2026-08-29: after one failed address read, every "Serve agents" tap
 * answered "No Cardano wallet is available for the selected account" instantly, for both granted
 * wallets, and the logs inside the builder never fired again — proof that it was never called. Only a
 * network switch (which clears the whole map) or an app restart recovered it.
 *
 * The in-flight promise *is* still shared, which is the part worth keeping: several callers asking at
 * once get one build rather than a thundering herd.
 *
 * @module
 */

/**
 * Return the cached entry for `key`, or start one with `build`.
 *
 * A result of `null` is dropped from the store as it resolves, so the next caller retries. A rejection
 * is not handled here — the caller owns how a thrown build is reported — but the entry is dropped for
 * it too, on the same reasoning.
 */
export const cachedBuild = <T>(
  store: Map<string, Promise<T | null>>,
  key: string,
  build: () => Promise<T | null>,
): Promise<T | null> => {
  const held = store.get(key)
  if (held !== undefined) return held
  const building = build().then(
    (value) => {
      // Drop *this* entry only if it is still ours: a later caller may already have replaced it after
      // a retry, and deleting that one would undo a good build.
      if (value === null && store.get(key) === building) store.delete(key)
      return value
    },
    (error: unknown) => {
      if (store.get(key) === building) store.delete(key)
      throw error
    },
  )
  store.set(key, building)
  return building
}
