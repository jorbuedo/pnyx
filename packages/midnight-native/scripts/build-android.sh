#!/usr/bin/env bash
# Cross-compile the native Midnight key-derivation crate to Android jniLibs.
#
# Requires: rustup with the Android targets, and an Android NDK (set ANDROID_NDK_HOME,
# or it auto-picks the highest version under $ANDROID_HOME/ndk).
#
# Output: packages/midnight-native/android/src/main/jniLibs/<abi>/libmidnight_native.so
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUST_DIR="$HERE/rust"
JNI_DIR="$HERE/android/src/main/jniLibs"
API=24

NDK="${ANDROID_NDK_HOME:-}"
# Accept either a concrete NDK dir or the parent `ndk/` dir; resolve to one with a toolchain.
if [[ -z "$NDK" || ! -d "$NDK/toolchains" ]]; then
  base="${NDK:-${ANDROID_HOME:-$HOME/Android/Sdk}/ndk}"
  NDK="$(ls -d "${base%/}"/*/toolchains 2>/dev/null | sort -V | tail -1)"
  NDK="${NDK%/toolchains}"
fi
[[ -n "$NDK" && -d "$NDK/toolchains" ]] || { echo "NDK not found; set ANDROID_NDK_HOME to a versioned NDK dir" >&2; exit 1; }
BIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"

# Rust target -> (Android ABI dir, clang prefix)
declare -A ABI=(
  [aarch64-linux-android]=arm64-v8a
  [x86_64-linux-android]=x86_64
  [armv7-linux-androideabi]=armeabi-v7a
)
declare -A CLANG=(
  [aarch64-linux-android]=aarch64-linux-android
  [x86_64-linux-android]=x86_64-linux-android
  [armv7-linux-androideabi]=armv7a-linux-androideabi
)

# Default to arm64 (real devices) + x86_64 (emulator); pass targets as args to override.
#
# ⚠️ Passing ONE target leaves the other ABI's .so exactly as it was, and the APK ships both. A
# rebuild of x86_64 alone therefore produces an emulator that works and an arm64 device that raises
# UnsatisfiedLinkError for anything added since — which reads as a broken feature, not a stale
# library. Hit on 2026-08-28: an arm64 .so two days old shipped beside a fresh x86_64 one. Check with
#   nm -D --defined-only android/src/main/jniLibs/<abi>/libmidnight_native.so | grep <YourNewSymbol>
# before concluding anything from a device.
TARGETS=("${@:-aarch64-linux-android x86_64-linux-android}")
read -ra TARGETS <<< "${TARGETS[*]}"

for target in "${TARGETS[@]}"; do
  echo ">> $target -> ${ABI[$target]}"
  rustup target add "$target" >/dev/null
  cc="$BIN/${CLANG[$target]}$API-clang"
  linker_env="CARGO_TARGET_$(echo "$target" | tr 'a-z-' 'A-Z_')_LINKER"
  env "CC_$target=$cc" "$linker_env=$cc" \
    cargo build --release --manifest-path "$RUST_DIR/Cargo.toml" --target "$target"
  dest="$JNI_DIR/${ABI[$target]}"
  mkdir -p "$dest"
  cp "$RUST_DIR/target/$target/release/libmidnight_native.so" "$dest/"
  echo "   -> $dest/libmidnight_native.so"
done
