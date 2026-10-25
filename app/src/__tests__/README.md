# Wallet App Unit Tests

This directory contains unit tests for the wallet application, organized by the packages/modules they test.

## Structure

```
__tests__/
└── blockchain/           # Tests for @pnyx/blockchain functions
    ├── mnemonic-generation.test.ts  # Tests for mnemonic generation (12, 15, 24 words)
    └── mnemonic-validation.test.ts  # Tests for mnemonic validation and error handling
```

## Test Organization Principles

Tests in this directory follow these principles:

1. **Unit Tests Only**: Each test file tests specific functions from imported packages
2. **Package-Based Organization**: Tests are organized by the package they test (e.g., `blockchain/` for `@pnyx/blockchain`)
3. **Function Testing**: All tests must call and verify behavior of imported functions (not just validate data structures)
4. **No E2E Tests**: True end-to-end tests (UI flows, user interactions) belong in a separate e2e testing framework (e.g., Detox, Playwright)

## Running Tests

```bash
# Run all wallet unit tests
bun run test

# Run only blockchain tests
bun run test app/src/__tests__/blockchain/

# Run specific test file
bun run test app/src/__tests__/blockchain/mnemonic-generation.test.ts

# Watch mode
bun run test:watch app/src/__tests__/
```

## Adding New Tests

When adding tests:

1. **Identify the package being tested**: e.g., `@pnyx/blockchain`, `@pnyx/wallet`, `@pnyx/cardano`
2. **Create appropriate directory**: e.g., `blockchain/`, `wallet/`, `cardano/`
3. **Name descriptively**: Use clear names that indicate what's being tested (e.g., `mnemonic-generation.test.ts`, not `create-wallet.test.ts`)
4. **Test imported functions**: Ensure tests actually call and verify behavior of imported functions
5. **Follow module header format**: Include JSDoc comment explaining what the test file covers

## Test Quality Standards

All tests must:
- ✅ Call and verify behavior of imported functions
- ✅ Test actual functionality, not type system guarantees
- ✅ Handle edge cases and error conditions
- ❌ NOT just validate static data, constants, or object structure
- ❌ NOT just check if exports are defined
- ❌ NOT just test local helper functions without testing imports
