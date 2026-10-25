/**
 * Why the native transaction reader would not read some bytes, in words an agent can act on.
 *
 * ⚠️ **"Not a Midnight transaction" is the wrong answer for most of these.** Telling a caller its bytes
 * are not a transaction sends it looking for a corrupt payload when it is usually holding a perfectly
 * good one and meeting a limit of ours.
 *
 * Measured 2026-08-29: `midnight_readTransaction` given the co-funded send this wallet itself signed,
 * fetched back from the preprod indexer, answered "those bytes are not a Midnight transaction this
 * wallet can read". The native error said exactly what was wrong and was discarded at `debug`. The
 * reader has since learned to read both binding states, so that particular case is now a *version*
 * signal rather than a limit — see below.
 *
 * @module
 */

/** The reader's own words when a header tag does not match what it accepts. */
const HEADER_MISMATCH = /expected header tag/i
/** The binding a transaction gains on its way to the chain. */
const BOUND = /pedersen-schnorr/i

/**
 * Turn a reader failure into a refusal that names the actual limit.
 *
 * Kept separate from the call site so the mapping can be tested without a native module, and so a new
 * reader error shape has one place to be added.
 */
export const midnightReadRefusal = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  if (HEADER_MISMATCH.test(message) && BOUND.test(message)) {
    // ⚠️ This should no longer happen: `tx_facts_json` reads both binding states as of 2026-08-29. If
    // it does, the native library on this device predates that change — the JS is ahead of the `.so`,
    // which is a build problem and not something the caller can fix by sending different bytes. Saying
    // so is the difference between chasing your own payload and rebuilding the native rail.
    return (
      'this wallet cannot read a bound transaction, which means its native library is older than the ' +
      'app: bound transactions have been readable since 2026-08-29. The bytes are fine — the device ' +
      'needs a rebuilt native rail.'
    )
  }
  if (HEADER_MISMATCH.test(message)) {
    return `that is not a transaction shape this reader accepts: ${message.split('\n')[0]}`
  }
  return 'those bytes are not a Midnight transaction this wallet can read'
}
