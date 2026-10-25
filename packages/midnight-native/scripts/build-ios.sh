#!/usr/bin/env bash
# Cross-compile the native Midnight key-derivation crate into an iOS XCFramework.
# MUST run on macOS with Xcode — iOS targets cannot be linked from Linux.
#
# Output: packages/midnight-native/ios/MidnightNative.xcframework
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUST_DIR="$HERE/rust"
OUT="$HERE/ios/MidnightNative.xcframework"

[[ "$(uname)" == "Darwin" ]] || { echo "iOS build requires macOS/Xcode" >&2; exit 1; }

# Must match MidnightNative.podspec's `:ios => '15.1'`. Without it rustc defaults
# to ios10.0, and blst's asm references __chkstk_darwin — a symbol libSystem only
# provides at min-OS >= 13, so the cdylib link fails with an undefined symbol.
export IPHONEOS_DEPLOYMENT_TARGET=15.1

DEVICE=aarch64-apple-ios          # real devices
SIM_ARM=aarch64-apple-ios-sim     # Apple-silicon simulator
SIM_X86=x86_64-apple-ios          # Intel simulator
for t in "$DEVICE" "$SIM_ARM" "$SIM_X86"; do rustup target add "$t" >/dev/null; done

build() { cargo build --release --manifest-path "$RUST_DIR/Cargo.toml" --target "$1"; }
lib() { echo "$RUST_DIR/target/$1/release/libmidnight_native.a"; }

build "$DEVICE"
build "$SIM_ARM"
build "$SIM_X86"

# Fat simulator lib (arm64 + x86_64). Must keep the SAME binary name as the
# device slice (`libmidnight_native.a`) or `-create-xcframework` emits slices
# with differing binary names, which CocoaPods refuses to install.
SIM_DIR="$RUST_DIR/target/ios-sim-universal"
mkdir -p "$SIM_DIR"
SIM_FAT="$SIM_DIR/libmidnight_native.a"
lipo -create "$(lib "$SIM_ARM")" "$(lib "$SIM_X86")" -output "$SIM_FAT"

rm -rf "$OUT"
xcodebuild -create-xcframework \
  -library "$(lib "$DEVICE")" -headers "$HERE/include" \
  -library "$SIM_FAT" -headers "$HERE/include" \
  -output "$OUT"
echo "-> $OUT"
