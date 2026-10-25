# Maestro E2E Tests

End-to-end tests for the Pnyx wallet app using [Maestro](https://maestro.mobile.dev/).

## E2E Build Profiles

We have **two EAS build profiles** for E2E testing:

| Profile | Purpose | Wallet State | Use For |
|---------|---------|--------------|---------|
| `e2e` | Test onboarding flows | No wallet (fresh app) | Create wallet, restore wallet, social login |
| `e2e-preseed` | Test post-onboarding flows | Wallet auto-restored on launch | Send, swap, receive, settings |

### How Pre-seeded Builds Work

When you build with `e2e-preseed` profile:

1. **EAS copies `.env.e2e-preseed`** which sets `EXPO_PUBLIC_E2E_AUTO_RESTORE=true`
2. **EAS injects secrets** from the `e2e-preseed` environment (mnemonic, password, wallet name)
3. **On app launch**, the app detects `AUTO_RESTORE=true` and:
   - Skips all onboarding screens (ToS, PIN, biometrics)
   - Restores wallet from the mnemonic
   - Enables all default chains (Cardano, Bitcoin, Ethereum, etc.)
   - Lands directly on the dashboard

### EAS Environment Setup

Secrets are configured in [Expo Dashboard](https://expo.dev) → Project → Environment variables.

Create an environment called `e2e-preseed` with these secrets:

| Secret | Description |
|--------|-------------|
| `EXPO_PUBLIC_E2E_MNEMONIC` | 24-word mnemonic (space-separated) |
| `EXPO_PUBLIC_E2E_WALLET_PASSWORD` | Wallet encryption password |
| `EXPO_PUBLIC_E2E_WALLET_NAME` | Display name for the wallet |

The `e2e-preseed` profile in `eas.json` references this environment:
```json
"e2e-preseed": {
  "extends": "e2e",
  "environment": "e2e-preseed"
}
```

## Prerequisites

### Install Maestro CLI

```bash
curl -Ls "https://get.maestro.mobile.dev" | bash
maestro --version
```

### Build the App

```bash
# For onboarding tests (fresh app)
eas build --profile e2e --platform ios

# For pre-seeded tests (wallet auto-restored)
eas build --profile e2e-preseed --platform ios
```

## Running Tests

### Onboarding Tests (e2e profile)

Tests that create or restore wallets:

```bash
# Run onboarding tests
bun scripts/e2e.ts ios --eas-profile e2e --tag onboarding

# Run specific onboarding flow
bun scripts/e2e.ts ios --eas-profile e2e --flow flows/onboarding/create-wallet-24.yaml
```

### Pre-seeded Tests (e2e-preseed profile)

Tests that start from the dashboard with a wallet already set up:

```bash
# Run pre-seeded tests
bun scripts/e2e.ts ios --eas-profile e2e-preseed --tag preseed

# Run specific pre-seeded flow
bun scripts/e2e.ts ios --eas-profile e2e-preseed --flow flows/preseed/send-cardano.yaml
```

### Local Development

For local testing with a dev build:

```bash
# Build dev client
bun ios

# Run tests (requires Metro running)
bun scripts/e2e.ts ios --tag smoke
```

## Directory Structure

```
maestro/
├── flows/
│   ├── onboarding/            # Tests for e2e profile (fresh app)
│   │   ├── create-wallet-24.yaml
│   │   ├── restore-wallet-*.yaml
│   │   └── social-login-*.yaml
│   ├── preseed/               # Tests for e2e-preseed profile (wallet ready)
│   │   ├── send-cardano.yaml
│   │   ├── receive-flow.yaml
│   │   ├── swap-navigation.yaml
│   │   └── settings-navigation.yaml
│   └── smoke/                 # Quick sanity tests
│       ├── app-launch.yaml
│       └── onboarding-navigation.yaml
├── utils/                     # Reusable flow fragments
│   ├── clear-and-launch.yaml
│   ├── accept-terms.yaml
│   ├── setup-pin.yaml
│   ├── setup-password.yaml
│   └── complete-wallet-creation.yaml
└── .env.example               # Environment template for local testing
```

## Test Tags

| Tag | Profile | Description |
|-----|---------|-------------|
| `smoke` | Either | Quick sanity tests |
| `onboarding` | `e2e` | Wallet creation/restoration |
| `social` | `e2e` | Social login flows |
| `preseed` | `e2e-preseed` | Tests requiring a wallet |
| `send` | `e2e-preseed` | Send transaction flows |
| `swap` | `e2e-preseed` | Swap flows |
| `receive` | `e2e-preseed` | Receive/QR code flows |
| `settings` | `e2e-preseed` | Settings navigation |

## Writing Tests

### Onboarding Flow (e2e profile)

```yaml
appId: ${MAESTRO_APP_ID}
tags:
  - onboarding
---
# Start fresh
- runFlow: ../../utils/clear-and-launch.yaml

# Accept terms and navigate to onboarding
- runFlow: ../../utils/accept-terms.yaml

# ... wallet creation steps ...

# Password setup
- runFlow: ../../utils/setup-password.yaml

# Complete wallet creation
- runFlow: ../../utils/complete-wallet-creation.yaml
```

### Pre-seeded Flow (e2e-preseed profile)

```yaml
appId: ${MAESTRO_APP_ID}
tags:
  - preseed
  - send
env:
  WALLET_PASSWORD: ${MAESTRO_WALLET_PASSWORD}
---
# Just launch - wallet is already restored
- launchApp

# Wait for dashboard
- extendedWaitUntil:
    visible:
      id: "account-card"
    timeout: 30000

# Wait for balance to load
- extendedWaitUntil:
    visible:
      id: "account-card-balance"
    timeout: 60000

# Now test from dashboard...
- tapOn:
    id: "send-button"
```

### Environment Variables in Flows

| Variable | Source | Description |
|----------|--------|-------------|
| `MAESTRO_APP_ID` | Test runner | App bundle ID |
| `MAESTRO_WALLET_PASSWORD` | GitHub secrets / local .env | Password for signing transactions |
| `MNEMONIC_12/15/24` | GitHub secrets / local .env | Recovery phrases for restore tests |

## GitHub Actions

Trigger from: **Actions → "[Pnyx] E2E Build - Mobile Client"**

| Input | Options | Notes |
|-------|---------|-------|
| Platform | `ios`, `android`, `all` | |
| EAS Profile | `e2e`, `e2e-preseed` | Choose based on test type |
| Run Tests | `true/false` | Auto-run Maestro after build |
| Test Tag | `smoke`, `onboarding`, `preseed`, etc. | |

## Troubleshooting

### Pre-seeded wallet not loading

1. Check EAS secrets are set in `e2e-preseed` environment
2. Verify you're using `--eas-profile e2e-preseed` (not `e2e`)
3. Check app logs for "E2E: Auto-restoring wallet" message

### App not found

```bash
# iOS - list installed apps
xcrun simctl listapps booted | grep CFBundleIdentifier

# Android - list packages
adb shell pm list packages | grep pxkq
```

### Element not found

1. Check `testID` is set on the component
2. Use Maestro Studio to inspect: `maestro studio`
3. Increase timeout if element loads slowly

## Best Practices

1. **Choose the right profile** - Use `e2e` for onboarding, `e2e-preseed` for everything else
2. **Use testIDs** - All interactive elements need `testID` props
3. **Tag appropriately** - Match tags to the correct profile
4. **Don't hardcode waits** - Use `extendedWaitUntil` with element visibility
5. **Keep flows independent** - Each flow should work in isolation
