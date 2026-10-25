const {withAndroidManifest} = require('@expo/config-plugins')

/**
 * Caps the two deprecated Bluetooth permissions at API 30, matching the library that
 * already caps them.
 *
 * Silences this build warning:
 *   "Expo Max Sdk Override Plugin >>> WARNING: Found 2 permission(s) with conflicting
 *    'android:maxSdkVersion' declarations … Removing 'android:maxSdkVersion' … "
 *
 * The conflict:
 *   - `react-native-ble-plx`'s config plugin writes BLUETOOTH and BLUETOOTH_ADMIN into
 *     the app manifest with NO maxSdkVersion.
 *   - `rxandroidble` (transitive, via the Ledger BLE bridge) declares the same two WITH
 *     `android:maxSdkVersion="30"`.
 *   - Expo's override plugin resolves the disagreement by dropping the cap from the
 *     merged manifest, which is the safe direction — over-requesting a deprecated
 *     permission is harmless, while under-requesting one needed on API 26–30 would
 *     break Ledger BLE there.
 *
 * Declaring the cap ourselves removes the disagreement instead of having it resolved:
 * API 26–30 still request the legacy permissions, and API 31+ stop requesting two
 * permissions that do nothing there. BLE on 31+ is unaffected — it runs on
 * BLUETOOTH_CONNECT and BLUETOOTH_SCAN, which `react-native-ble-plx` declares
 * separately and this plugin does not touch.
 *
 * 30 is not a choice: it is the last API level on which these permissions mean
 * anything, and it is the value rxandroidble already uses. Matching it is the point.
 */
const LEGACY_BLUETOOTH_PERMISSIONS = ['android.permission.BLUETOOTH', 'android.permission.BLUETOOTH_ADMIN']

const LAST_SUPPORTED_SDK = '30'

module.exports = function withBluetoothLegacyMaxSdk(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest

    if (!Array.isArray(manifest['uses-permission'])) {
      manifest['uses-permission'] = []
    }

    for (const permission of LEGACY_BLUETOOTH_PERMISSIONS) {
      const existing = manifest['uses-permission'].find((entry) => entry.$?.['android:name'] === permission)
      // Only ever annotates a declaration another plugin made. Adding one here would
      // request a permission on 26–30 that nothing in the app had asked for.
      if (existing) {
        existing.$['android:maxSdkVersion'] = LAST_SUPPORTED_SDK
      }
    }

    return config
  })
}
