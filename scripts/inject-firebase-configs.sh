#!/usr/bin/env bash
# Decode Firebase config secrets into the files the build expects.
#
# CI: provide the four env vars below from GitHub Actions secrets (base64 of each file).
# Local without secrets: copy the *.example placeholders (compiles; push won't deliver),
# or fetch real configs with `firebase apps:sdkconfig` against the pnyx-app project.
set -euo pipefail
cd "$(dirname "$0")/../app"

inject() { # $1=env var name, $2=target file
  local value="${!1:-}"
  if [[ -n "$value" ]]; then
    printf '%s' "$value" | base64 -d > "$2"
    echo "injected $2"
  elif [[ ! -f "$2" ]]; then
    cp "$2.example" "$2"
    echo "placeholder $2 (no $1 provided)"
  fi
}

inject GOOGLE_SERVICES_JSON google-services.json
inject GOOGLE_SERVICES_DEV_JSON google-services.dev.json
inject GOOGLE_SERVICE_INFO_PLIST GoogleService-Info.plist
inject GOOGLE_SERVICE_INFO_DEV_PLIST GoogleService-Info.dev.plist
