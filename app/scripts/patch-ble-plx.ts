/**
 * Patches react-native-ble-plx and expo-updates for New Architecture compatibility.
 *
 * react-native-ble-plx 3.5.1 fixed the Android SafePromise null error code crash,
 * but the iOS NSNull issue (#1278) remains unpatched upstream. TurboModules interop
 * passes NSNull instead of nil for null JS arguments, crashing createClient and
 * startDeviceScan.
 *
 * expo-updates ErrorRecovery catches the fatal error from the TurboModules interop
 * layer and force-crashes the app. The patch suppresses the crash and logs instead.
 *
 * @see https://github.com/dotintent/react-native-ble-plx/issues/1278
 * @see https://github.com/facebook/react-native/issues/53960
 */

import {existsSync, readFileSync, realpathSync, writeFileSync} from 'node:fs'
import {resolve} from 'node:path'

// bun hoists workspace dependencies to the repo root, so `app/node_modules`
// holds only the few packages that had to nest. Check both roots or the patches
// silently no-op.
const NODE_MODULES_ROOTS = [resolve(__dirname, '../node_modules'), resolve(__dirname, '../../node_modules')]

/** Absolute path to a file inside an installed package, or null if the package isn't installed. */
const resolvePackagePath = (packageName: string, relativePath: string): string | null => {
  for (const root of NODE_MODULES_ROOTS) {
    if (!existsSync(resolve(root, packageName))) continue
    return realpathSync(resolve(root, packageName, relativePath))
  }
  return null
}

// ============================================================================
// iOS: NSNull guard for New Architecture (TurboModules) compatibility
// ============================================================================
//
// TurboModules passes NSNull instead of nil for null JS arguments.
// createClient receives NSNull where NSString* is expected → NSException → crash.
// startDeviceScan receives NSNull for filteredUUIDs/options → crash.
//
// Fix from: https://github.com/dotintent/react-native-ble-plx/issues/1278
// Replaces BlePlx.m with a patched version containing NSNull guards.

const PATCHED_BLEPLX_M_PATH = resolve(__dirname, 'patched-BlePlx.m')

const bleplxPath = resolvePackagePath('react-native-ble-plx', 'ios/BlePlx.m')

if (!bleplxPath) {
  console.log('⏭ react-native-ble-plx not installed, skipping iOS patch')
} else {
  try {
    const iosContent = readFileSync(bleplxPath, 'utf-8')

    if (iosContent.includes('dispatch_get_main_queue')) {
      console.log('✔ react-native-ble-plx BlePlx.m already patched (issue #1278)')
    } else {
      const patchedContent = readFileSync(PATCHED_BLEPLX_M_PATH, 'utf-8')
      writeFileSync(bleplxPath, patchedContent)
      console.log('✔ Patched react-native-ble-plx BlePlx.m (issue #1278 NSNull guard)')
    }
  } catch (error) {
    // The package is installed, so a missing patch target is a real failure, not a skip.
    console.error('✖ Failed to patch react-native-ble-plx (iOS):', error)
    process.exit(1)
  }
}

// ============================================================================
// expo-updates: Suppress ErrorRecovery.crash() on iOS
// ============================================================================
// expo-updates ErrorRecovery catches unhandled JS errors and crashes the app
// when no OTA update is available to roll back to. react-native-ble-plx
// generates a fatal error through TurboModules interop that goes directly
// to RCTFatalHandler, bypassing JS try/catch.
// See: https://github.com/facebook/react-native/issues/53960

const erPath = resolvePackagePath('expo-updates', 'ios/EXUpdates/ErrorRecovery.swift')

if (!erPath) {
  console.log('⏭ expo-updates not installed, skipping ErrorRecovery patch')
} else {
  try {
    let erContent = readFileSync(erPath, 'utf-8')

    if (erContent.includes('suppressed crash')) {
      console.log('✔ expo-updates ErrorRecovery.crash() already patched')
    } else {
      const original = erContent
      erContent = erContent.replace(
        `  private func crash() {\n    // create new exception object from stack of errors\n    // use the initial error and put the rest into userInfo\n    let initialError = encounteredErrors.first!`,
        `  private func crash() {\n    // PATCHED: suppressed crash — log errors instead\n    NSLog("[ErrorRecovery] suppressed crash, %d errors:", encounteredErrors.count)\n    for (i, err) in encounteredErrors.enumerated() {\n      NSLog("[ErrorRecovery] [%d] %@", i, String(describing: err))\n    }\n    encounteredErrors.removeAll()\n    isRunning = false\n    return\n    // original (unreachable):\n    let initialError = encounteredErrors.first!`,
      )
      if (erContent === original) {
        console.error('✖ expo-updates ErrorRecovery.crash() patch target not found — source may have changed')
        process.exit(1)
      }
      writeFileSync(erPath, erContent)
      console.log('✔ Patched expo-updates ErrorRecovery.crash() (suppress crash)')
    }
  } catch (error) {
    console.error('⚠ Failed to patch expo-updates ErrorRecovery:', error)
  }
}
