/**
 * Observable state of the SteelSwap credential, so a dead key reads as a real
 * error instead of an empty screen.
 *
 * Before this, a failed mint degraded to "no price" / "no tokens" everywhere,
 * which is indistinguishable from a token that genuinely has no price — the
 * exact confusion the every-error-path-logs rule exists to prevent. The swap
 * and portfolio surfaces subscribe and can say *why* they are empty.
 *
 * Deliberately not a React context: `steelswap-auth` is platform-free and must
 * stay unit-testable, so this is a plain store with a subscribe hook on top
 * (`hooks/useSteelswapCredential.ts`).
 *
 * @module
 */

export type SteelswapCredentialState =
  /** No mint attempted yet this process. */
  | {readonly tag: 'idle'}
  /**
   * The endpoint injects the credential server-side (our token proxy), so the app holds none.
   *
   * A distinct tag from `partner` because the fee is attributed to Pnyx by the *endpoint* rather
   * than by anything this build carries: there is no key here to reject, re-mint or leak.
   */
  | {readonly tag: 'endpoint'}
  /** A CIP-8 mint is in flight. */
  | {readonly tag: 'minting'}
  /** A usable key is held (RAM, storage, or freshly minted). */
  | {readonly tag: 'ready'}
  /**
   * The build's Pnyx partner key is in use — no mint happens, and swap fees are attributed to us.
   *
   * A distinct tag from `ready` because the two differ in what a later failure means: a rejected
   * partner key cannot be replaced from the app, so the surface has to say something an operator can
   * act on rather than "retrying".
   */
  | {readonly tag: 'partner'}
  /** SteelSwap rejected the partner key. Not recoverable in-app: it is minted out-of-band. */
  | {readonly tag: 'partnerRejected'}
  /** No signer is registered — no identity yet, so no credential can be minted. */
  | {readonly tag: 'noSigner'}
  /** The mint failed. `reason` is the machine-ish cause, for the log and support. */
  | {readonly tag: 'failed'; readonly reason: string}

type Listener = (state: SteelswapCredentialState) => void

let current: SteelswapCredentialState = {tag: 'idle'}
const listeners = new Set<Listener>()

export const steelswapCredentialState = (): SteelswapCredentialState => current

export const setSteelswapCredentialState = (next: SteelswapCredentialState): void => {
  if (next.tag === current.tag && (next.tag !== 'failed' || next.reason === (current as {reason?: string}).reason)) {
    return
  }
  current = next
  for (const l of listeners) l(next)
}

export const subscribeSteelswapCredential = (listener: Listener): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Reset — tests only. */
export const resetSteelswapCredentialState = (): void => {
  current = {tag: 'idle'}
  listeners.clear()
}
