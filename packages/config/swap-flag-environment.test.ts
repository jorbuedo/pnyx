// The swap vertical is held out of production while the SteelSwap integration is unfinished, and
// stays reachable in dev and preview. That is the whole point of the flag, so it is asserted per
// environment rather than left to the defaults table being read correctly.
import {describe, expect, it} from 'vitest'
import {evaluateFeatureFlag} from './feature-flags-evaluation.js'
import type {EnvironmentId, EvaluationContext} from './index.js'

const context = (environment: EnvironmentId, remoteConfig?: EvaluationContext['remoteConfig']): EvaluationContext => ({
  platform: 'mobile',
  environment,
  installationId: 'install-1',
  buildNumber: 1,
  runtimeOverrides: [],
  remoteConfig,
})

describe('swap flag by environment', () => {
  it('is off in production', () => {
    expect(evaluateFeatureFlag('swap', context('production')).enabled).toBe(false)
  })

  it('is on in development', () => {
    expect(evaluateFeatureFlag('swap', context('development')).enabled).toBe(true)
  })

  it('is on in preview', () => {
    expect(evaluateFeatureFlag('swap', context('preview')).enabled).toBe(true)
  })

  it('can still be turned on in production from remote config, without a rebuild', () => {
    // The point of holding it at the code default rather than hard-coding `false` at the call site:
    // finishing the integration should not need an app release.
    expect(evaluateFeatureFlag('swap', context('production', {swap: true})).enabled).toBe(true)
  })

  it('a runtime override still wins in production, for on-device testing', () => {
    const evaluation = evaluateFeatureFlag('swap', {
      ...context('production'),
      runtimeOverrides: [{flagId: 'swap', enabled: true, setAt: 0}],
    })
    expect(evaluation.enabled).toBe(true)
    expect(evaluation.source).toBe('runtime')
  })
})

describe('preview is its own layer, not an alias', () => {
  it('does not inherit development’s blanket-enable', () => {
    // `portfolioChart` is on in development and absent from preview, so preview must fall through to
    // the code default. If preview ever gets aliased to development again, this is what catches it.
    expect(evaluateFeatureFlag('portfolioChart', context('development')).enabled).toBe(true)
    expect(evaluateFeatureFlag('portfolioChart', context('preview')).enabled).toBe(false)
    expect(evaluateFeatureFlag('portfolioChart', context('production')).enabled).toBe(false)
  })

  it('keeps devTools off, exactly as production does', () => {
    expect(evaluateFeatureFlag('devTools', context('preview')).enabled).toBe(false)
  })
})
