#!/usr/bin/env bash
set -euo pipefail

# EAS Build Post-Install Hook
# Runs AFTER bun install
#
# Responsibilities:
# - Configure Android NDK environment
# - Set up gradle.properties with NDK version
#
# Environment variables (set by EAS):
#   EAS_BUILD_PLATFORM - ios or android
#   EAS_BUILD_PROFILE - development, preview, production
#   ANDROID_NDK_HOME - Android NDK path (may be set by pre-install)

echo "=== EAS Post-Install Hook ==="

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "Platform: ${EAS_BUILD_PLATFORM:-not set}"
echo "Profile: ${EAS_BUILD_PROFILE:-not set}"


# ============================================================================
# Android NDK Configuration
# ============================================================================
configure_android_ndk() {
  echo ""
  echo "=== Configuring Android NDK ==="

  SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-${HOME}/Android/Sdk}}"
  NDK_VERSION="${ANDROID_NDK_VERSION:-27.0.12077973}"

  # Resolve sdkmanager path
  SDKMANAGER="${SDK_ROOT}/cmdline-tools/latest/bin/sdkmanager"
  if [[ ! -x "${SDKMANAGER}" ]]; then
    SDKMANAGER="$(command -v sdkmanager || true)"
  fi

  if [[ -n "${SDKMANAGER}" ]]; then
    # Accept licenses just in case
    yes | "${SDKMANAGER}" --sdk_root="${SDK_ROOT}" --licenses >/dev/null 2>&1 || true

    if [[ ! -d "${SDK_ROOT}/ndk/${NDK_VERSION}" ]]; then
      echo "Installing Android NDK ${NDK_VERSION} into ${SDK_ROOT}/ndk/${NDK_VERSION}"
      "${SDKMANAGER}" --sdk_root="${SDK_ROOT}" --install "ndk;${NDK_VERSION}"
    else
      echo "Android NDK ${NDK_VERSION} already present at ${SDK_ROOT}/ndk/${NDK_VERSION}"
    fi
  fi

  # Use the requested (or latest) side-by-side NDK and export common env vars
  if [[ -d "${SDK_ROOT}/ndk/${NDK_VERSION}" ]]; then
    SELECTED_NDK_DIR="${SDK_ROOT}/ndk/${NDK_VERSION}"
  else
    SELECTED_NDK_DIR="$(ls -1d "${SDK_ROOT}/ndk"/* 2>/dev/null | sort -V | tail -n1 || true)"
  fi

  if [[ -z "${SELECTED_NDK_DIR}" || ! -d "${SELECTED_NDK_DIR}" ]]; then
    echo "Android NDK directory not found after installation attempt; skipping Rust prebuild"
    return 1
  fi

  export ANDROID_NDK_ROOT="${SELECTED_NDK_DIR}"
  export ANDROID_NDK_HOME="${SELECTED_NDK_DIR}"
  export ANDROID_NDK="${SELECTED_NDK_DIR}"

  if command -v set-env >/dev/null 2>&1; then
    set-env ANDROID_NDK_ROOT "${ANDROID_NDK_ROOT}"
    set-env ANDROID_NDK_HOME "${ANDROID_NDK_HOME}"
    set-env ANDROID_NDK "${ANDROID_NDK}"
    # Also provide as JVM system properties for Gradle plugins that only read from system props
    set-env JAVA_TOOL_OPTIONS "-DANDROID_NDK_HOME=${ANDROID_NDK_ROOT} -DANDROID_NDK_ROOT=${ANDROID_NDK_ROOT} -DANDROID_NDK=${ANDROID_NDK_ROOT} ${JAVA_TOOL_OPTIONS:-}"
  fi

  echo "Using NDK at ${SELECTED_NDK_DIR}"
  return 0
}

# ============================================================================
# Gradle Properties Configuration
# ============================================================================
configure_gradle_properties() {
  echo ""
  echo "=== Configuring Gradle Properties ==="

  NDK_VERSION="${ANDROID_NDK_VERSION:-27.0.12077973}"
  GRADLE_PROPERTIES="${ROOT_DIR}/android/gradle.properties"
  mkdir -p "${ROOT_DIR}/android"

  if [[ -f "${GRADLE_PROPERTIES}" ]]; then
    if grep -q '^android.ndkVersion=' "${GRADLE_PROPERTIES}"; then
      sed -i.bak -E "s|^android.ndkVersion=.*$|android.ndkVersion=${NDK_VERSION}|" "${GRADLE_PROPERTIES}" || true
    else
      # Ensure file ends with a newline before appending
      if [[ -n "$(tail -c1 "${GRADLE_PROPERTIES}" 2>/dev/null || true)" ]]; then
        printf "\n" >> "${GRADLE_PROPERTIES}"
      fi
      printf "android.ndkVersion=%s\n" "${NDK_VERSION}" >> "${GRADLE_PROPERTIES}"
      printf "org.gradle.project.android.ndkVersion=%s\n" "${NDK_VERSION}" >> "${GRADLE_PROPERTIES}"
    fi
  else
    {
      printf "android.ndkVersion=%s\n" "${NDK_VERSION}"
      printf "org.gradle.project.android.ndkVersion=%s\n" "${NDK_VERSION}"
    } > "${GRADLE_PROPERTIES}"
  fi

  echo "Ensured android.ndkVersion=${NDK_VERSION} in ${GRADLE_PROPERTIES}"

  # Ensure Python interpreter is available to linker wrapper
  if command -v set-env >/dev/null 2>&1; then
    set-env RUST_ANDROID_GRADLE_PYTHON_COMMAND python3
  else
    export RUST_ANDROID_GRADLE_PYTHON_COMMAND=python3
  fi
}

# ============================================================================
# iOS Specific Setup
# ============================================================================
setup_ios() {
  echo ""
  echo "=== iOS Post-Install Setup ==="

  # Install CocoaPods dependencies if needed
  if [[ -f "$ROOT_DIR/ios/Podfile" ]]; then
    echo "Installing CocoaPods dependencies..."
    (
      cd "$ROOT_DIR/ios"

      # Use ccache if available
      if command -v ccache &> /dev/null; then
        export USE_CCACHE=1
        echo "ccache enabled"
      fi

      pod install --repo-update
    )
  else
    echo "No ios/Podfile found (will be created by prebuild)"
  fi
}

# ============================================================================
# Build TypeScript Packages
# ============================================================================
build_typescript_packages() {
  echo ""
  echo "=== Building TypeScript Packages ==="

  # Build all workspace packages (generates dist/ folders)
  cd "$(cd "$SCRIPT_DIR/../../../.." && pwd)"  # Go to monorepo root
  bun run build
  cd "$ROOT_DIR"

  echo "TypeScript packages built successfully"
}

# ============================================================================
# Main
# ============================================================================
main() {
  cd "$ROOT_DIR"

  # Build workspace packages first (required for Metro bundling)
  build_typescript_packages

  if [[ "${EAS_BUILD_PLATFORM:-}" == "android" ]]; then
    if configure_android_ndk; then
      configure_gradle_properties
    fi
  elif [[ "${EAS_BUILD_PLATFORM:-}" == "ios" ]]; then
    setup_ios
  else
    echo "Unknown platform: ${EAS_BUILD_PLATFORM:-not set}"
    echo "Running generic post-install..."
  fi

  echo ""
  echo "=== Post-Install Hook Complete ==="
}

main "$@"
