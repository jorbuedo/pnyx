# Bridge implementation — Android done, iOS remaining

## Android — DONE and verified in-app ✅

Approach: **Expo module + JNI** (not Nitro — JNI was simpler to land and verify).

- `rust/src/jni_bridge.rs` exports `Java_expo_modules_midnightnative_MidnightNativeModule_*` (Android-only via `#[cfg(target_os = "android")]` + the `jni` crate).
- `android/src/main/java/expo/modules/midnightnative/MidnightNativeModule.kt` — `System.loadLibrary("midnight_native")`, three `external fun`s, exposed as hex-string `Function`s.
- `package.json` + `expo-module.config.json` make this an autolinked Expo-module package; the app links it via `app` `expo.autolinking.searchPaths += ../../packages/midnight-native`.
- `src/index.ts` (`@pnyx/midnight-native`) is the JS surface; `packages/wallet/.../midnight-curve-backend.native.ts` consumes it; metro resolves `.native.ts` on RN.

Verified: `expo run:android` → `[MidnightNativeCheck] PASS` (wallet JS → Expo/JNI → Rust `.so` → correct golden-vector addresses). The `.so` is at `android/src/main/jniLibs/<abi>/` (default AGP location, gitignored, built by `scripts/build-android.sh`).

> Gotcha: the app's `./modules` dir is NOT scanned once custom `searchPaths` are set — that's why this is a path-referenced package rather than a local `app/modules/*` module. Also, the first `:app:packageDebug` can flake (`IncrementalSplitterRunnable`); re-run / `assembleDebug` succeeds.

## iOS — remaining (macOS only)

Mirror the Android Expo module for iOS. The C ABI already exists (`include/midnight_native.h`) — Swift calls it directly (no JNI needed on iOS).

### 1. Build the xcframework (on macOS)
```bash
bash scripts/build-ios.sh   # → ios/MidnightNative.xcframework (device + simulator slices)
```

### 2. Add the iOS module to this package
`expo-module.config.json` — add the iOS platform + module:
```json
{
  "platforms": ["android", "ios"],
  "android": {"modules": ["expo.modules.midnightnative.MidnightNativeModule"]},
  "ios": {"modules": ["MidnightNativeModule"]}
}
```

`ios/MidnightNative.podspec` — vendor the xcframework + expose the C header:
```ruby
Pod::Spec.new do |s|
  s.name = 'MidnightNative'
  s.version = '0.1.0'
  s.platforms = { :ios => '15.1' }
  s.source_files = 'ios/**/*.{swift}'
  s.vendored_frameworks = 'ios/MidnightNative.xcframework'
  s.preserve_paths = '../include/**/*.h'
  s.pod_target_xcconfig = { 'SWIFT_OBJC_BRIDGING_HEADER' => '$(PODS_TARGET_SRCROOT)/ios/MidnightNative-Bridging-Header.h' }
  s.dependency 'ExpoModulesCore'
end
```

`ios/MidnightNative-Bridging-Header.h`:
```c
#import "midnight_native.h"
```

`ios/MidnightNativeModule.swift` — call the C ABI, same hex-string contract as Kotlin:
```swift
import ExpoModulesCore

public class MidnightNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MidnightNative")
    Function("nightPayload") { (keyHex: String) -> String in try derive(keyHex, 32, midnight_night_payload) }
    Function("dustPublicKey") { (keyHex: String) -> String in try derive(keyHex, 32, midnight_dust_public_key) }
    Function("shieldedPublicKeys") { (keyHex: String) -> String in try derive(keyHex, 64, midnight_shielded_public_keys) }
  }

  private func derive(_ keyHex: String, _ outLen: Int,
                      _ fn: (UnsafePointer<UInt8>?, UnsafeMutablePointer<UInt8>?) -> Int32) throws -> String {
    let key = [UInt8](hex: keyHex)
    guard key.count == 32 else { throw Exception(name: "Midnight", description: "role key must be 32 bytes") }
    var out = [UInt8](repeating: 0, count: outLen)
    let rc = key.withUnsafeBufferPointer { k in out.withUnsafeMutableBufferPointer { o in fn(k.baseAddress, o.baseAddress) } }
    guard rc == 0 else { throw Exception(name: "Midnight", description: "derive failed, code \(rc)") }
    return out.map { String(format: "%02x", $0) }.joined()
  }
}
// + a [UInt8](hex:) initializer helper.
```

### 3. Verify
`npx expo prebuild -p ios && npx expo run:ios` on a simulator → same `[MidnightNativeCheck] PASS` in the Metro/console logs. Then a real iPhone (and a real Android arm64 device) via Settings → Networks → enable Midnight → Receive → Midnight, matching the golden vectors in `rust/src/lib.rs`.

## Optional follow-up cleanup (both platforms working)

RN no longer bundles `@midnight-ntwrk/ledger-v8` (it's imported only by `midnight-curve-backend.ts`, which metro doesn't resolve on native). So these become dead weight on the native path and can be removed once iOS is confirmed: `app/src/services/midnight-wasm.native.ts`, the `#self` branch in `app/metro.config.js`, `app/scripts/patch-midnight-ledger.ts`, and the native side of the `registerMidnightLedgerInitializer()` call. Keep the web/Node WASM path (`midnight-curve-backend.ts` + `midnight-wasm.ts`).
