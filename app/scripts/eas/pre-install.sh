#!/usr/bin/env bash
set -euo pipefail

# EAS Build Pre-Install Hook
# Runs BEFORE bun install
#
# Responsibilities:
# - Install Rust toolchain with all required targets
# - Install Android NDK if on Android platform
# - Propagate git commit hash to EXPO_PUBLIC_COMMIT
# - Copy the profile-specific environment file
#
# Environment variables (set by EAS):
#   EAS_BUILD_PLATFORM - ios or android
#   EAS_BUILD_PROFILE - development, preview, production
#   EAS_BUILD_GIT_COMMIT_HASH - Git commit hash

echo "=== EAS Pre-Install Hook ==="

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "Platform: ${EAS_BUILD_PLATFORM:-not set}"
echo "Profile: ${EAS_BUILD_PROFILE:-not set}"


# ============================================================================
# Environment File Setup
# ============================================================================
copy_env_file() {
  echo ""
  echo "=== Copying Environment File ==="
  bash "$SCRIPT_DIR/copy-env.sh"
}

# ============================================================================
# Git Commit Hash Propagation
# ============================================================================
propagate_git_commit() {
  echo ""
  echo "=== Propagating Git Commit Hash ==="

  if [[ -n "${EAS_BUILD_GIT_COMMIT_HASH:-}" ]]; then
    echo "Setting EXPO_PUBLIC_COMMIT from EAS_BUILD_GIT_COMMIT_HASH"
    if command -v set-env >/dev/null 2>&1; then
      set-env EXPO_PUBLIC_COMMIT "${EAS_BUILD_GIT_COMMIT_HASH}"
    else
      export EXPO_PUBLIC_COMMIT="${EAS_BUILD_GIT_COMMIT_HASH}"
    fi
    echo "EXPO_PUBLIC_COMMIT=${EAS_BUILD_GIT_COMMIT_HASH}"
  else
    # Fallback for local builds where EAS_BUILD_GIT_COMMIT_HASH isn't available
    if git rev-parse --verify HEAD >/dev/null 2>&1; then
      GIT_SHA="$(git rev-parse HEAD)"
      echo "Setting EXPO_PUBLIC_COMMIT from local git HEAD"
      if command -v set-env >/dev/null 2>&1; then
        set-env EXPO_PUBLIC_COMMIT "${GIT_SHA}"
      else
        export EXPO_PUBLIC_COMMIT="${GIT_SHA}"
      fi
      echo "EXPO_PUBLIC_COMMIT=${GIT_SHA}"
    else
      echo "No git commit hash available"
    fi
  fi
}

# ============================================================================
# Rust Toolchain Installation
# ============================================================================
install_rust() {
  echo ""
  echo "=== Installing Rust Toolchain ==="

  # Install rustup non-interactively if not installed
  if ! command -v rustup >/dev/null 2>&1; then
    echo "Installing rustup..."
    curl https://sh.rustup.rs -sSf | sh -s -- -y
  else
    echo "rustup already installed"
  fi

  # Ensure cargo bin is on PATH for the rest of the build
  export PATH="$HOME/.cargo/bin:$PATH"

  # Persist PATH for subsequent EAS build steps if helper is available
  if command -v set-env >/dev/null 2>&1; then
    set-env PATH "$HOME/.cargo/bin:$PATH"
  fi

  # Add all required targets (iOS, Android, WASM)
  echo "Adding Rust targets..."
  rustup target add \
    aarch64-apple-darwin \
    aarch64-apple-ios \
    aarch64-apple-ios-sim \
    aarch64-linux-android \
    armv7-linux-androideabi \
    i686-linux-android \
    wasm32-unknown-unknown \
    x86_64-apple-ios \
    x86_64-linux-android

  echo "Rust installation complete"
  rustc --version
  cargo --version
}

# ============================================================================
# Android NDK Installation
# ============================================================================
install_android_ndk() {
  if [[ "${EAS_BUILD_PLATFORM:-}" != "android" ]]; then
    return 0
  fi

  echo ""
  echo "=== Installing Android NDK ==="

  # Default to the version specified in eas.json
  NDK_VERSION="${ANDROID_NDK_VERSION:-27.0.12077973}"

  SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-${HOME}/Android/Sdk}}"
  SDKMANAGER="${SDK_ROOT}/cmdline-tools/latest/bin/sdkmanager"
  if [[ ! -x "${SDKMANAGER}" ]]; then
    SDKMANAGER="$(command -v sdkmanager || true)"
  fi

  if [[ -z "${SDKMANAGER}" ]]; then
    echo "sdkmanager not found; cannot install NDK proactively. Gradle will attempt installation later."
    return 0
  fi

  echo "Ensuring Android NDK ${NDK_VERSION} is installed (SDK root: ${SDK_ROOT})"

  # Accept licenses non-interactively
  yes | "${SDKMANAGER}" --sdk_root="${SDK_ROOT}" --licenses >/dev/null 2>&1 || true

  if [[ -d "${SDK_ROOT}/ndk/${NDK_VERSION}" ]]; then
    echo "NDK ${NDK_VERSION} already installed at ${SDK_ROOT}/ndk/${NDK_VERSION}"
  else
    echo "Installing NDK ${NDK_VERSION}..."
    "${SDKMANAGER}" --sdk_root="${SDK_ROOT}" --install "ndk;${NDK_VERSION}"
  fi

  if [[ -d "${SDK_ROOT}/ndk/${NDK_VERSION}" ]]; then
    export ANDROID_NDK_ROOT="${SDK_ROOT}/ndk/${NDK_VERSION}"
    export ANDROID_NDK_HOME="${SDK_ROOT}/ndk/${NDK_VERSION}"
    export ANDROID_NDK="${SDK_ROOT}/ndk/${NDK_VERSION}"

    if command -v set-env >/dev/null 2>&1; then
      set-env ANDROID_NDK_ROOT "${ANDROID_NDK_ROOT}"
      set-env ANDROID_NDK_HOME "${ANDROID_NDK_HOME}"
      set-env ANDROID_NDK "${ANDROID_NDK}"
    fi

    echo "NDK ready at ${ANDROID_NDK_ROOT}"

    # Ensure Gradle subprojects can resolve NDK by setting ndk.dir in local.properties
    LOCAL_PROPERTIES="${ROOT_DIR}/android/local.properties"
    mkdir -p "${ROOT_DIR}/android"

    if [[ -f "${LOCAL_PROPERTIES}" ]]; then
      if grep -q '^ndk.dir=' "${LOCAL_PROPERTIES}"; then
        # Replace existing ndk.dir line
        sed -i.bak -E "s|^ndk.dir=.*$|ndk.dir=${ANDROID_NDK_ROOT}|" "${LOCAL_PROPERTIES}" || true
      else
        echo "ndk.dir=${ANDROID_NDK_ROOT}" >> "${LOCAL_PROPERTIES}"
      fi
    else
      # Also include sdk.dir if known
      {
        if [[ -n "${SDK_ROOT}" ]]; then echo "sdk.dir=${SDK_ROOT}"; fi
        echo "ndk.dir=${ANDROID_NDK_ROOT}"
      } > "${LOCAL_PROPERTIES}"
    fi
    echo "Wrote ndk.dir to ${LOCAL_PROPERTIES}"
  else
    echo "Warning: NDK ${NDK_VERSION} not found after installation attempt"
  fi
}

# ============================================================================
# Main
# ============================================================================
main() {
  cd "$ROOT_DIR"

  copy_env_file
  propagate_git_commit
  install_rust
  install_android_ndk

  echo ""
  echo "=== Pre-Install Hook Complete ==="
}

main "$@"
