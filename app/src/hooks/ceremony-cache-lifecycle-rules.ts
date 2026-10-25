/**
 * Pure decision rules for the credential-vault ceremony cache lifecycle.
 *
 * Extracted from {@link ./useCeremonyCacheLifecycle.ts} so the rules can
 * be unit-tested in isolation (the hook itself imports `react-native`,
 * which doesn't resolve under Vitest's node environment).
 *
 * @module
 */

/**
 * Identifier shape of an `AppStateStatus` value. Mirrors
 * `react-native`'s union so callers can pass the native value through
 * without forcing the rules module to depend on `react-native`.
 */
export type AppStateLike = 'active' | 'background' | 'inactive' | 'unknown' | 'extension' | string

/**
 * Returns `true` when this `AppState` transition should evict the
 * ceremony cache.
 *
 * **`'inactive'` is deliberately excluded.** iOS fires `'inactive'` for
 * momentary system-modal overlays — Face ID / Touch ID, permission
 * sheets, Control Center — which are exactly the prompts this cache
 * exists to skip on subsequent signs. Wiping on `'inactive'` would
 * clear the entry *during* the very biometric prompt that populates it,
 * so the cache would never warm and every sig#2 would re-prompt the
 * user. Same rationale as `useLockScreen.ts`'s lock-screen evictor.
 */
export const shouldEvictOnAppStateChange = (state: AppStateLike): boolean => state === 'background'

/**
 * Returns `true` when this `isUnlocked` transition should evict the
 * ceremony cache.
 *
 * Only the `true → false` edge counts as a real logout. The initial
 * mount with `isUnlocked === false` (before the user has ever
 * authenticated this session) must NOT fire — any future pre-seed flow
 * that warms the cache before login would otherwise see it wiped on
 * the very first render.
 */
export const shouldEvictOnAuthChange = (wasEverUnlocked: boolean, isUnlocked: boolean): boolean =>
  wasEverUnlocked && !isUnlocked
