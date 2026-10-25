require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'MidnightNative'
  s.version        = package['version'] || '0.1.0'
  s.summary        = 'Native Midnight key derivation (curve math) — wraps Midnight\'s own crates, no WASM.'
  s.description    = 'Expo module bridging libmidnight_native (Rust) for Night/DUST/shielded receive-address derivation.'
  s.license        = 'Apache-2.0'
  s.author         = 'Pnyx'
  s.homepage       = 'https://pnyx.pxkq.uk'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: 'https://pnyx.pxkq.uk/pnyx.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Rust static lib (libmidnight_native.a) bundled per-arch; built by scripts/build-ios.sh.
  # Symbols are bound from Swift via @_silgen_name (see MidnightNativeModule.swift),
  # so no header/modulemap is required at compile time — only link-time symbol resolution.
  s.vendored_frameworks = 'MidnightNative.xcframework'

  s.source_files = '*.{h,m,mm,swift}'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
