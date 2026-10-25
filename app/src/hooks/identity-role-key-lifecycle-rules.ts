/**
 * Pure lifecycle rules for the identity role-key cache
 * (`services/identity-role-keys.ts`).
 *
 * Separate from the ceremony cache's rules on purpose: the two have **different**
 * policies and collapsing them would silently change one. The ceremony cache
 * evicts on `background`; these keys survive it and evict only on lock.
 *
 * @module
 */

/**
 * Role keys never evict on an `AppState` change — not even `background`.
 *
 * Backgrounding is continuous on mobile (app switcher, notification shade,
 * another app for two seconds) and is not a security event. Evicting there would
 * re-prompt biometrics for signatures the user never asked for, which is the cost
 * this cache exists to remove.
 *
 * A function rather than a constant so the asymmetry with
 * `shouldEvictOnAppStateChange` is visible and testable at the call site instead
 * of being an omission someone later "fixes".
 */
export const shouldEvictRoleKeysOnAppStateChange = (_state: string): boolean => false

/**
 * Evict on a real unlock → lock transition, and only that edge.
 *
 * The initial mount has `isUnlocked === false` before the user has ever
 * authenticated; firing there would wipe a cache that a pre-unlock warm had just
 * populated. Same guard as the ceremony cache's auth rule.
 */
export const shouldEvictRoleKeysOnAuthChange = (wasEverUnlocked: boolean, isUnlocked: boolean): boolean =>
  wasEverUnlocked && !isUnlocked
