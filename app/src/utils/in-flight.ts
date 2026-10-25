/**
 * Cache the in-flight promise, not just the settled result.
 *
 * ⚠️ **A result cache does nothing for callers that arrive together, and they do.** Measured on a
 * read-only wallet load: `POST /account_addresses` went out **six times within nine milliseconds** for
 * the same stake key, because three hooks and the import path all called it before any of them had
 * written to the cache. On the wallet that prompted this, each of those responses was 51 MB.
 *
 * Storing the promise closes the window: the second caller gets the first caller's work.
 *
 * @module
 */

/**
 * `run()` once per `key`, with concurrent callers sharing the same promise.
 *
 * ⚠️ **A rejection is not cached.** Keeping it would turn one failed request into a permanent answer,
 * so the entry is dropped and the next caller may try again — which is what the callers here expect,
 * since they treat a failure as "unknown", not as "no".
 */
export const inFlight = <T>(store: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> => {
  const existing = store.get(key)
  if (existing !== undefined) return existing
  const started = run()
  store.set(
    key,
    started.catch((error: unknown) => {
      store.delete(key)
      throw error
    }),
  )
  // The stored promise carries the cleanup; hand callers one that behaves identically.
  return store.get(key) ?? started
}
