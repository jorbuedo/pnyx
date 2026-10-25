const {withAndroidManifest} = require('@expo/config-plugins')

/**
 * Resolves a Play Store AAB upload rejection:
 *   "Duplicate declarations of <uses-permission> element
 *    'android.permission.ACCESS_COARSE_LOCATION' (or ACCESS_FINE_LOCATION)
 *    in manifest with different maxSdkVersions."
 *
 * The conflict comes from `react-native-ble-plx`:
 *   - The library's own AndroidManifest declares both COARSE/FINE LOCATION
 *     as plain <uses-permission> with NO maxSdkVersion.
 *   - The Expo config plugin (with neverForLocation: true) ALSO adds
 *     <uses-permission-sdk-23 ... maxSdkVersion="30"> entries to the app
 *     manifest. Play Store treats <uses-permission-sdk-23> as equivalent
 *     to <uses-permission> for validation, so it sees two declarations
 *     of the same permission with different maxSdkVersion bounds.
 *
 * Fix: declare the same permissions in the app manifest with
 * `tools:node="remove"` so the merger drops the library's unconstrained
 * <uses-permission>. The plugin's <uses-permission-sdk-23 maxSdkVersion="30">
 * remains and is the single canonical declaration in the merged manifest.
 */
const PERMISSIONS_TO_DROP = ['android.permission.ACCESS_COARSE_LOCATION', 'android.permission.ACCESS_FINE_LOCATION']

module.exports = function withBleLocationPermissions(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest

    // Ensure tools namespace is declared so tools:node is honored
    manifest.$['xmlns:tools'] = manifest.$['xmlns:tools'] ?? 'http://schemas.android.com/tools'

    if (!Array.isArray(manifest['uses-permission'])) {
      manifest['uses-permission'] = []
    }

    for (const permission of PERMISSIONS_TO_DROP) {
      const existing = manifest['uses-permission'].find((entry) => entry.$?.['android:name'] === permission)
      if (existing) {
        existing.$['tools:node'] = 'remove'
        // Strip any other attrs — `remove` only needs the name match
        delete existing.$['android:maxSdkVersion']
      } else {
        manifest['uses-permission'].push({
          $: {
            'android:name': permission,
            'tools:node': 'remove',
          },
        })
      }
    }

    return config
  })
}
