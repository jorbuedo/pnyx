# Maestro flows (local development)

Shared UI-driving flows for the iOS simulator. Hand-run during local
development — they don't run in CI. The proper preseed regression
tests live under `app/e2e/maestro/flows/preseed/` and run via
the EAS preseed pipeline.

## Setup

Maestro CLI from the official tap (NOT the cask of the same name):

```bash
brew install --formula mobile-dev-inc/tap/maestro
```

Java is required. Homebrew installs `openjdk` as a dependency, but it's keg-only — set `JAVA_HOME` before invoking maestro:

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home
export PATH=$JAVA_HOME/bin:$PATH
export MAESTRO_CLI_NO_ANALYTICS=1
```

Sourcable from `/tmp/maestro-env.sh` during a session.

## Running a flow

```bash
source /tmp/maestro-env.sh
maestro test app/maestro/flows/close-dev-logs.yaml
```

## Conventions

- **Prefer `id:` (testID) over `text:` over `point:`.** testIDs are durable, text changes with i18n, points break on different viewports.
- **All screenshots write to `/tmp/proto-diff/`** so they sit alongside the proto-diff workflow outputs.
- **Each flow does ONE thing.** Compose with subflows via `runFlow:` rather than long monolithic YAML.
- **No CI.** These are developer tooling — not part of the lint or test pipeline. Maestro must be installed locally to run them.

## Known testIDs

- `dev-logs-close` — X button on the System Logs dev menu
- `reviewTx-confirmButton` — primary CTA on review-tx (Authorize / Confirm / Sign)
- `reviewTx-cancelButton` — secondary CTA on review-tx
- `signing-cancel-button` / `signing-retry-button` — SigningOverlay buttons
- `siwe-domainMismatch` / `siwe-viewDetails` / `siwe-detailsModal` — SIWE chrome

Run `maestro hierarchy | grep resource-id` to discover more.

## Gotchas

- `xcrun simctl` is faster than `maestro` for raw screenshots — use `xcrun simctl io booted screenshot /tmp/...png`. Reserve maestro for taps + waits + assertions.
- Maestro's `takeScreenshot` argument is `path:` (no extension — appends `.png` itself).
- Hot-reload happens automatically when JS source changes; you don't need to relaunch.
