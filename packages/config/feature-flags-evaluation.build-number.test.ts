import {describe, expect, it} from 'vitest'

import {type EvaluationContext, evaluateFeatureFlag} from './feature-flags-evaluation.js'

const baseContext = (overrides: Partial<EvaluationContext> = {}): EvaluationContext => ({
  platform: 'mobile',
  environment: 'production',
  installationId: 'test-install-id',
  buildNumber: 1,
  runtimeOverrides: [],
  remoteConfig: undefined,
  ...overrides,
})

describe('evaluateFeatureFlag — build-number targeting', () => {
  it('respects remote-config minBuildNumber: falls through to lower layer when build is too low', () => {
    // portfolioChart: code default false (no version), remote says on but only
    // for buildNumber >= 42. App is on 41 → expect false from the code layer.
    const result = evaluateFeatureFlag(
      'portfolioChart',
      baseContext({
        buildNumber: 41,
        remoteConfig: {portfolioChart: {enabled: true, minBuildNumber: 42}},
      }),
    )
    expect(result.enabled).toBe(false)
    expect(result.source).toBe('code')
  })

  it('respects remote-config minBuildNumber: applies when build meets minimum', () => {
    const result = evaluateFeatureFlag(
      'portfolioChart',
      baseContext({
        buildNumber: 42,
        remoteConfig: {portfolioChart: {enabled: true, minBuildNumber: 42}},
      }),
    )
    expect(result.enabled).toBe(true)
    expect(result.source).toBe('remote')
  })

  it('respects remote-config maxBuildNumber: skips layer when build is above ceiling', () => {
    const result = evaluateFeatureFlag(
      'portfolioChart',
      baseContext({
        buildNumber: 200,
        remoteConfig: {portfolioChart: {enabled: true, maxBuildNumber: 100}},
      }),
    )
    expect(result.enabled).toBe(false)
    expect(result.source).toBe('code')
  })

  it('runtime override wins regardless of build constraints on lower layers', () => {
    const result = evaluateFeatureFlag(
      'portfolioChart',
      baseContext({
        buildNumber: 1,
        runtimeOverrides: [{flagId: 'portfolioChart', enabled: true, setAt: 0}],
        remoteConfig: {portfolioChart: {enabled: false, minBuildNumber: 9999}},
      }),
    )
    expect(result.enabled).toBe(true)
    expect(result.source).toBe('runtime')
  })

  it('combined min + max bounds at the remote layer', () => {
    const remoteConfig = {
      portfolioChart: {enabled: true, minBuildNumber: 42, maxBuildNumber: 99},
    }
    const inRange = evaluateFeatureFlag('portfolioChart', baseContext({buildNumber: 60, remoteConfig}))
    const tooLow = evaluateFeatureFlag('portfolioChart', baseContext({buildNumber: 41, remoteConfig}))
    const tooHigh = evaluateFeatureFlag('portfolioChart', baseContext({buildNumber: 100, remoteConfig}))
    expect(inRange.enabled).toBe(true)
    expect(inRange.source).toBe('remote')
    expect(tooLow.enabled).toBe(false)
    expect(tooLow.source).toBe('code')
    expect(tooHigh.enabled).toBe(false)
    expect(tooHigh.source).toBe('code')
  })

  it('plain boolean values are not affected by buildNumber', () => {
    const result = evaluateFeatureFlag(
      'portfolioChart',
      baseContext({
        buildNumber: 1,
        remoteConfig: {portfolioChart: true},
      }),
    )
    expect(result.enabled).toBe(true)
    expect(result.source).toBe('remote')
  })

  it('combines rolloutPercentage and minBuildNumber', () => {
    // 100% rollout, but only on build 42+
    const result = evaluateFeatureFlag(
      'portfolioChart',
      baseContext({
        buildNumber: 41,
        remoteConfig: {portfolioChart: {enabled: true, rolloutPercentage: 100, minBuildNumber: 42}},
      }),
    )
    expect(result.enabled).toBe(false)
    expect(result.source).toBe('code')
  })

  it('fails open when buildNumber is 0 (Expo Go / dev) — version-gated remote layer still applies', () => {
    const result = evaluateFeatureFlag(
      'portfolioChart',
      baseContext({
        buildNumber: 0,
        remoteConfig: {portfolioChart: {enabled: true, minBuildNumber: 9999}},
      }),
    )
    expect(result.enabled).toBe(true)
    expect(result.source).toBe('remote')
  })
})
