/**
 * The Android notification channel id, alone in a module with no native imports.
 *
 * ⚠️ Separated so non-RN callers can read it: the prebuild plugin's test compares this against the
 * value written into the manifest, and importing it from `notifee-setup` drags in
 * `@notifee/react-native` and the whole RN chain. Two copies of a channel id that must match, with
 * no way to check them, is how the manifest silently ends up pointing at a channel nobody creates.
 *
 * @module
 */

export const NOTIFEE_CHANNEL_ID = 'pnyx_push'

/**
 * The channel direct messages are displayed on.
 *
 * ⚠️ **Its real job is identification, not grouping.** A `notification` payload is drawn by Android
 * without the app, and notifee's view of an OS-drawn notification carries **no data** — so on resume
 * the sweep imported a DM as a row with no `kind`, no conversation, and no way for anything to clear
 * it. `channelId` is the one field that survives, so the sweep can recognise what the payload can no
 * longer tell it. Kept in step with the service's `channelForKind`.
 *
 * That it also gives DMs their own row in Android's notification settings is a genuine second benefit,
 * and what per-category settings will build on.
 */
export const NOTIFEE_DM_CHANNEL_ID = 'pnyx_dm'

/**
 * The status-bar icon, as the prebuild plugin installs it.
 *
 * ⚠️ **The manifest meta-data only covers notifications *Android* draws** — the backgrounded case.
 * Anything the app displays itself through notifee falls back to the launcher icon, which Android
 * flattens to a white blob, so every `displayNotification` has to name this explicitly or the fix
 * shows up in one case and not the other.
 */
export const NOTIFICATION_SMALL_ICON = 'ic_stat_pnyx'
