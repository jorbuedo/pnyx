/**
 * What a name claim is doing, held outside React so it survives navigation.
 *
 * ⚠️ **A claim is long, multi-step and can fail at the last one.** A real run takes around a hundred
 * seconds: deploy the shell, wait for it to land, prove a permit on device (~10 s), wait for the mint,
 * prove the bind (~8 s), fund it, relay the registration, then wait for the row. Progress lived in a
 * `busy` boolean inside `useHandleActions` — and there are two instances of that hook, one per screen,
 * so leaving the claim screen lost the state entirely and a failure arrived as a toast that had
 * already gone by the time you looked.
 *
 * This is deliberately a module-level store rather than a context: nothing about a claim belongs to a
 * screen, and the indicator has to render on tabs the claim screen knows nothing about.
 *
 * @module
 */

/** The steps a claim actually goes through, in order. */
export const CLAIM_PHASES = [
  'shell',
  'awaiting-shell',
  'permit',
  'awaiting-permit',
  'bind',
  'relaying',
  'awaiting-row',
] as const

export type ClaimPhase = (typeof CLAIM_PHASES)[number]

export type ClaimProgress = {
  /** The name being claimed, as typed. */
  readonly name: string
  readonly phase: ClaimPhase
  /**
   * Set when the claim is over. `failed` keeps the reason on screen instead of a toast that has
   * already vanished — the one thing you want after a hundred seconds of waiting.
   */
  readonly outcome?: {readonly kind: 'claimed'} | {readonly kind: 'failed'; readonly reasonKey: string}
}

type Listener = (progress: ClaimProgress | undefined) => void

let current: ClaimProgress | undefined
const listeners = new Set<Listener>()

const emit = (): void => {
  for (const listener of listeners) listener(current)
}

/** Subscribe to progress. Returns an unsubscribe; `useSyncExternalStore`-shaped. */
export const subscribeToClaim = (listener: Listener): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The current claim, or `undefined` when none is running and none has finished unacknowledged. */
export const claimSnapshot = (): ClaimProgress | undefined => current

/** A claim has begun. Replaces any finished one still on screen. */
export const claimStarted = (name: string): void => {
  current = {name, phase: 'shell'}
  emit()
}

/** Move to `phase`. Ignored once an outcome is set, so a late report cannot revive a finished claim. */
export const claimAt = (phase: ClaimPhase): void => {
  if (current === undefined || current.outcome !== undefined) return
  current = {...current, phase}
  emit()
}

/** The claim ended. The entry stays until {@link clearClaim} so the result can be read. */
export const claimEnded = (outcome: NonNullable<ClaimProgress['outcome']>): void => {
  if (current === undefined) return
  current = {...current, outcome}
  emit()
}

/** Dismiss a finished claim. A running one is left alone — there is nothing to dismiss yet. */
export const clearClaim = (): void => {
  if (current?.outcome === undefined) return
  current = undefined
  emit()
}

/** Test seam: drop all state and listeners. */
export const resetClaimProgress = (): void => {
  current = undefined
  listeners.clear()
}
