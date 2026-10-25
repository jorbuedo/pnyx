#!/bin/bash
set -euo pipefail

# Copy the environment file for the EAS build profile
#
# Environment variables (set by EAS):
#   EAS_BUILD_PROFILE - development, preview, production

echo "=== Copying Environment File ==="

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROFILE="${EAS_BUILD_PROFILE:-development}"

# Map EAS profile to env file variant
# development:device -> development
VARIANT="${PROFILE%%:*}"

echo "Profile: $PROFILE"
echo "Variant: $VARIANT"

ENV_SRC="$ROOT_DIR/env/.env.$VARIANT"
ENV_DEST="$ROOT_DIR/.env"

if [[ -f "$ENV_SRC" ]]; then
  cp "$ENV_SRC" "$ENV_DEST"
  echo "✓ Copied $ENV_SRC → .env"
else
  echo "⚠ Environment file not found: $ENV_SRC"
  # Create an empty .env so the build has one
  : > "$ENV_DEST"
  echo "✓ Created empty .env"
fi

echo "=== Environment File Copy Complete ==="
