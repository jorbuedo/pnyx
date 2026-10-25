/**
 * Brand identity constants used at runtime.
 *
 * Only the deep-link scheme and display name are read at runtime (deep-link
 * dispatch, protocol-handler registration, the About screen).
 *
 * @module
 */

export const brand = {
  displayName: 'Pnyx',
  /** URL scheme for deep links (e.g. `pnyx://`). */
  scheme: 'pnyx',
} as const
