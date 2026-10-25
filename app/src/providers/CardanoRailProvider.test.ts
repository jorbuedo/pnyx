/**
 * Drift guard: the Cardano rail pipeline runs ONCE for the app, and the provider that runs it is
 * actually mounted.
 *
 * This was a plain hook with 23 call sites, and each one ran the whole resolve → discover →
 * upgrade → sync pipeline for the same wallet. Measured on device 2026-09-12: three consumers on
 * the Wallets screen produced three of every pipeline log line inside 3 ms. Nothing in the type
 * system stops that returning — re-exporting the pipeline as a hook, or adding a second
 * `useCardanoRailPipeline()` call, restores it silently and the only symptom is a log file nobody
 * reads and Koios calls nobody counts.
 *
 * The mount assertion is the other half: `useCardanoRail` throws without a provider above it, so an
 * unmounted provider turns every Cardano screen into an error boundary rather than a slow screen.
 *
 * @module
 */

import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

const APP_ROOT = join(__dirname, '..', '..')
const PROVIDER = readFileSync(join(__dirname, 'CardanoRailProvider.tsx'), 'utf8')
const LAYOUT = readFileSync(join(APP_ROOT, 'app', '_layout.tsx'), 'utf8')
const HOOK = readFileSync(join(APP_ROOT, 'src', 'hooks', 'useCardanoRail.ts'), 'utf8')

describe('the Cardano rail has a single runner', () => {
  it('calls the pipeline exactly once, from the provider', () => {
    const calls = PROVIDER.match(/useCardanoRailPipeline\(\)/g) ?? []
    expect(calls).toHaveLength(1)
  })

  it('does not export the pipeline, so no consumer can run its own', () => {
    expect(PROVIDER).not.toMatch(/export\s+(const|function)\s+useCardanoRailPipeline/)
  })

  it('serves consumers from a context rather than per-consumer state', () => {
    expect(PROVIDER).toMatch(/useContext\(CardanoRailContext\)/)
    expect(HOOK).toMatch(/export\s*\{[^}]*useCardanoRail[^}]*\}\s*from\s*'\.\.\/providers\/CardanoRailProvider'/)
  })

  it('is mounted in the root layout, or every consumer throws', () => {
    expect(LAYOUT).toMatch(/<CardanoRailProvider>/)
    expect(LAYOUT).toMatch(/<\/CardanoRailProvider>/)
  })
})
