# E2E Tests

This directory contains end-to-end tests for the Pnyx wallet application.

## Test Frameworks

- [Maestro](./maestro/README.md) - Mobile E2E tests (iOS/Android)

## Running Tests

### Quick Start - Mobile Tests (Maestro)

```bash
# Run all tests on iOS
bun e2e:ios

# Run all tests on Android
bun e2e:android

# Run smoke tests only
bun e2e:smoke:ios
bun e2e:smoke:android
```

## Organization

```
e2e/
├── README.md           # This file
├── docs/               # E2E testing notes
└── maestro/            # Maestro mobile E2E tests
    ├── README.md       # Maestro documentation
    ├── .env            # Environment variables (copy from .env.example)
    ├── .env.example    # Environment template
    ├── flows/          # Test flows
    └── utils/          # Reusable fragments
```
