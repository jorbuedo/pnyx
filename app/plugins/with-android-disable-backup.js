const {withAndroidManifest} = require('@expo/config-plugins')

/**
 * Forces android:allowBackup="false" on the app's <application> node.
 *
 * Wallet data must never leave the device via Google Auto Backup / `adb backup`.
 * With allowBackup enabled and no exclusion rules, Android captures the app's
 * MMKV stores (incl. `@pnyx/wallet/groups` and `@pnyx/wallet/xpubs`) and
 * silently restores them on reinstall — so a fresh install boots into a stale
 * "existing wallet" the user never restored, and encrypted seed blobs become
 * eligible for cloud backup.
 *
 * `tools:replace` is required so our value wins the manifest merge regardless of
 * what any dependency declares (e.g. ramp-sdk-android sets allowBackup=false,
 * others may set true); without it the merger aborts the build on conflict.
 */
module.exports = function withAndroidDisableBackup(config) {
  return withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application?.[0]
    if (app) {
      // Deduped, because this appends to whatever is already on the node and an
      // `expo prebuild` WITHOUT `--clean` re-runs against the manifest it produced last
      // time. A second pass produced `tools:replace="android:allowBackup,android:allowBackup"`,
      // which AGP rejects outright: "Multiple entries with same key:
      // android:allowBackup=REPLACE and android:allowBackup=REPLACE". `bun android` passes
      // --clean, which is why this stayed hidden.
      const existing = app.$['tools:replace']?.split(',').map((v) => v.trim()) ?? []
      app.$['tools:replace'] = [...new Set([...existing, 'android:allowBackup'])].filter(Boolean).join(',')
      app.$['android:allowBackup'] = 'false'
    }
    return config
  })
}
