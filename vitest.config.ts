import * as path from 'node:path'
import {fileURLToPath} from 'node:url'
import {defineConfig} from 'vitest/config'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default defineConfig({
  test: {
    // Register a CJS require() extension handler for static asset files
    // (SVG, PNG, etc.) before any test modules are imported. This lets
    // wallet source files use require('./foo.svg') without a SyntaxError —
    // production builds (Metro, webpack) handle these natively.
    setupFiles: [
      path.resolve(__dirname, 'app/src/__tests__/setup-env.ts'),
      path.resolve(__dirname, 'app/src/__tests__/setup-asset-mocks.ts'),
    ],
    include: [
      'packages/**/*.test.ts',
      'app/**/*.test.ts',
      'examples/**/*.test.ts',
      'harness/**/*.test.ts',
      'services/**/src/**/*.test.ts',
      'infra/**/*.test.ts',
    ],
    // Pnyx harness/simulator tests do real proving; they need generous timeouts.
    testTimeout: 120_000,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // Exclude wallet-service tests - Vitest/Rollup can't parse react-native module
      // imported via @sentry/react-native. These tests mostly verify type definitions.
      'app/src/__tests__/wallet-service.test.ts',
      // Fork tests require Anvil (foundry) and run via their own vitest config
      '**/*.fork.test.ts',
    ],
    alias: [
      {
        find: 'react-native',
        replacement: path.resolve(__dirname, 'app/src/__tests__/__mocks__/react-native.ts'),
      },
      {
        find: 'expo-constants',
        replacement: path.resolve(__dirname, 'app/src/__tests__/__mocks__/expo-constants.ts'),
      },
      {
        find: 'react-native-keychain',
        replacement: path.resolve(__dirname, 'app/src/__tests__/__mocks__/react-native-keychain.ts'),
      },
    ],
    coverage: {
      provider: 'v8',
      thresholds: {
        lines: 60,
        branches: 50, // Effect-TS internal branches can be hard to cover
        functions: 60,
        statements: 60,
      },
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/*.d.ts',
        '**/coverage/**',
        '**/.*/**',
        '**/*.test.ts',
        '**/test/**',
        '**/tests/**',
        '**/__tests__/**',
        '**/__fixtures__/**',
        '**/__mocks__/**',
        '**/index.ts',
        '**/vitest.config.ts',
        '**/types.ts', // Schema type definitions
        '**/presets/**', // Config presets are data, not logic
        '**/e2e/**',
      ],
    },
  },
})
