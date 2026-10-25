import * as path from 'node:path'
import {fileURLToPath} from 'node:url'
import {defineConfig} from 'vitest/config'

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// This is a workaround, see https://github.com/vitest-dev/vitest/issues/4744
export default defineConfig({
  esbuild: {
    target: 'es2020',
  },
  optimizeDeps: {
    exclude: ['bun:sqlite'],
  },
  test: {
    setupFiles: [path.join(__dirname, 'setupTests.ts')],
    fakeTimers: {
      toFake: undefined,
    },
    sequence: {
      concurrent: true,
    },
    include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    alias: {
      '@pnyx/crypto': path.resolve(__dirname, 'packages/crypto'),
      '@pnyx/config': path.resolve(__dirname, 'packages/config'),
      '@pnyx/logger': path.resolve(__dirname, 'packages/logger'),
      '@pnyx/storage': path.resolve(__dirname, 'packages/storage'),
      '@pnyx/signer': path.resolve(__dirname, 'packages/signer'),
      '@pnyx/swap': path.resolve(__dirname, 'packages/swap'),
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'build/',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.spec.ts',
        '**/*.spec.tsx',
        '**/*.d.ts',
        '**/coverage/**',
        '**/.tsbuildinfo',
        '**/index.ts', // Exclude barrel exports from coverage
        '**/vitest.config.ts',
        '**/setupTests.ts',
        '**/wallet/errors.ts', // Pure error type definitions
        '**/dapp-connector/chains/cardano/cip30-adapter.ts', // Depends on hardware wallet Signer
      ],
      // Coverage thresholds (allows for defensive code paths)
      thresholds: {
        lines: 80,
        functions: 70,
        branches: 75, // Effect-TS internal branches can be hard to cover
        statements: 80,
      },
      // Report uncovered lines
      reportOnFailure: true,
    },
  },
})
