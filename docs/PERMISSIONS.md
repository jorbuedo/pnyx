# App Permissions

Single source of truth for every permission the wallet app requests on iOS and
Android: **what** it is, **why** we need it, and **where** it's declared.

The Android manifest merger combines `<uses-permission>` entries from every
linked library, every Expo config plugin, and `app/app.config.js`. When
the same permission is declared in more than one place with different
attributes (`maxSdkVersion`, `usesPermissionFlags`, …), Play Store rejects the
AAB upload with `Duplicate declarations of <uses-permission> element ... with
different maxSdkVersions`. Read the Android section before adding anything to
`android.permissions` in `app/app.config.js`.

## iOS

iOS permissions live as `NSXxxUsageDescription` strings in the `infoPlist`
section of `app/app.config.js`. The string itself is shown to the user
in the system permission prompt, so it doubles as both the request justification
to Apple App Review and the user-facing copy.

| Key | Triggered by | Purpose |
|---|---|---|
| `NSCameraUsageDescription` | `expo-camera` | Scan QR codes. |
| `NSUserNotificationUsageDescription` | `expo-notifications` + `@react-native-firebase/messaging` | Wallet activity notifications and FCM push delivery. |
| `NSFaceIDUsageDescription` | `expo-local-authentication` | Face ID to authorize transactions and unlock the wallet. |
| `UIBackgroundModes: ['fetch', 'remote-notification']` | `@react-native-firebase/messaging`, background sync | Receive push notifications and run periodic chain sync in the background. |
| `ITSAppUsesNonExemptEncryption: false` | App Store Connect compliance | Declares no use of non-standard cryptography subject to US export rules. We use only standard TLS / OS crypto APIs from the user's perspective. |

## Android

Android permissions come from three sources:

1. **Library `AndroidManifest.xml`** — every `node_modules/<lib>/android/src/main/AndroidManifest.xml` is merged in by Gradle.
2. **Expo config plugins** — JS plugins that mutate the app's `AndroidManifest.xml` during `expo prebuild`.
3. **`android.permissions: [...]`** in `app/app.config.js` — written verbatim into the app's `AndroidManifest.xml`.

When a permission is declared by a library or plugin, **do not re-declare it in
`android.permissions`**. The bare app-level declaration carries no
`maxSdkVersion` and no flags, which conflicts with the library's attributes and
trips the Play Store duplicate check.

### Permissions declared by libraries (do NOT add to `android.permissions`)

| Permission | Declared by | Purpose |
|---|---|---|
| `POST_NOTIFICATIONS` | `expo-notifications` library manifest | Android 13+ runtime notification permission. |
| `RECEIVE_BOOT_COMPLETED` | `expo-notifications` library manifest | Reschedule local notifications after a reboot. |
| `CAMERA` | `expo-camera` library manifest | Camera capture (QR scanning). |
| `RECORD_AUDIO` | `expo-camera` library manifest | Auto-included by `expo-camera`. We do not record audio. |
| `READ_EXTERNAL_STORAGE` | `expo-file-system` library manifest | File system access. Mostly inert on modern Android (scoped storage). |
| `WRITE_EXTERNAL_STORAGE` | `expo-file-system` library manifest | Same — only honored on SDK ≤ 28. |
| `INTERNET` | many libraries | Network access. |
| `ACCESS_NETWORK_STATE` | `@react-native-firebase/messaging`, `@sentry/react-native`, `expo-image`, `expo-updates` | Detect network state for retry / offline behavior. |
| `WAKE_LOCK` | `@react-native-firebase/messaging` | Hold the CPU awake briefly while processing FCM messages. |
| `VIBRATE` | `expo-haptics` | Haptic feedback. |
| `USE_FINGERPRINT` | `expo-local-authentication` | Pre-Android-9 biometric auth (fingerprint). |
| `USE_BIOMETRIC` | `expo-local-authentication` | Android 9+ biometric auth (fingerprint, face). |

### Permissions explicitly added in `android.permissions`

Only permissions that **no library declares** belong here. The list is
currently empty (`permissions: []` in `app/app.config.js`).

### Adding a new permission

1. Run `grep -rn "android.permission.NEW_PERMISSION" node_modules` to check
   whether a library or config plugin already declares it. If yes, **do not**
   add it to `android.permissions`.
2. If no library declares it, add it to `android.permissions` in
   `app/app.config.js` and document it in the table above.
3. If a library declares it but with attributes you need to override
   (`maxSdkVersion`, `usesPermissionFlags`, removal), write a config plugin
   under `app/plugins/` using the `withAndroidManifest` helper +
   `tools:node="replace"` / `"remove"` rather than re-declaring in
   `android.permissions` (which can never override library attributes
   cleanly).
4. For iOS, add a matching `NSXxxUsageDescription` to `infoPlist` in
   `app/app.config.js` and document it in the iOS table above. The
   string is shown to users in the system prompt — keep it specific and
   user-friendly.
