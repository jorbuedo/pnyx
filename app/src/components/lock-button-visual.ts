/**
 * How the header's lock button looks at each stage of the hold.
 *
 * Its own module so the icon rule is testable without a renderer.
 *
 * @module
 */

import type {UniIconName} from './UniIcon'

export type LockHoldPhase = 'idle' | 'holding' | 'committed'

export type LockButtonVisual = {
  /**
   * Bound to the registry via `Extract` rather than a bare string union: if
   * either key is ever renamed away, this fails to compile instead of
   * rendering nothing (`UniIcon` returns `null` for an unknown name).
   */
  readonly icon: Extract<UniIconName, 'lock' | 'lockOpen'>
  readonly scale: number
  readonly opacity: number
}

/**
 * The padlock rests **open**: this button lives in the tab header, which both
 * lock rails unmount — the gate replaces the shell for the PIN, and the session
 * lock routes to `(lock)/login` — so whenever it is on screen the app is
 * unlocked by definition. `committed` is therefore the only moment the shut
 * padlock is ever visible, which is what makes it the confirmation.
 *
 * | phase       | icon       | scale | opacity |
 * |-------------|------------|-------|---------|
 * | `idle`      | `lockOpen` | 1     | 1       |
 * | `holding`   | `lockOpen` | 0.92  | 0.55    |
 * | `committed` | `lock`     | 1     | 1       |
 */
export const lockButtonVisual = (phase: LockHoldPhase): LockButtonVisual => {
  switch (phase) {
    case 'holding':
      return {icon: 'lockOpen', scale: 0.92, opacity: 0.55}
    case 'committed':
      return {icon: 'lock', scale: 1, opacity: 1}
    case 'idle':
      return {icon: 'lockOpen', scale: 1, opacity: 1}
  }
}
