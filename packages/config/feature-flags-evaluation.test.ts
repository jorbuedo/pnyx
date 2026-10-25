/**
 * @vitest-environment node
 */
import {describe, expect, it} from 'vitest'
import type {EvaluationContext} from './feature-flags-evaluation.js'
import {evaluateFeatureFlag, resolveFeatureFlagValue} from './feature-flags-evaluation.js'

describe('resolveFeatureFlagValue', () => {
  it('should return boolean values directly', () => {
    expect(resolveFeatureFlagValue(true, 'test-id', 'discover')).toBe(true)
    expect(resolveFeatureFlagValue(false, 'test-id', 'discover')).toBe(false)
  })

  it('should return false if enabled is false', () => {
    expect(resolveFeatureFlagValue({enabled: false}, 'test-id', 'discover')).toBe(false)
    expect(resolveFeatureFlagValue({enabled: false, rolloutPercentage: 100}, 'test-id', 'discover')).toBe(false)
  })

  it('should return true if enabled with no rollout percentage', () => {
    expect(resolveFeatureFlagValue({enabled: true}, 'test-id', 'discover')).toBe(true)
  })

  it('should apply rollout percentage consistently', () => {
    // Same installation ID should always get same result
    const installationId = 'test-installation-123'
    const result1 = resolveFeatureFlagValue({enabled: true, rolloutPercentage: 50}, installationId, 'discover')
    const result2 = resolveFeatureFlagValue({enabled: true, rolloutPercentage: 50}, installationId, 'discover')
    expect(result1).toBe(result2)
  })

  it('should enable for 100% rollout', () => {
    expect(resolveFeatureFlagValue({enabled: true, rolloutPercentage: 100}, 'any-id', 'discover')).toBe(true)
  })

  it('should disable for 0% rollout', () => {
    expect(resolveFeatureFlagValue({enabled: true, rolloutPercentage: 0}, 'any-id', 'discover')).toBe(false)
  })
})

describe('evaluateFeatureFlag - Five-layer precedence', () => {
  const baseContext: EvaluationContext = {
    platform: 'mobile',
    environment: 'production',
    installationId: 'test-id',
    buildNumber: 1,
    runtimeOverrides: [],
    remoteConfig: undefined,
  }

  describe('Layer 1: Code defaults', () => {
    it('should use code default when no higher layers apply', () => {
      const result = evaluateFeatureFlag('portfolioChart', baseContext)
      // portfolioChart defaults to false in CODE_DEFAULTS and is not overridden by platform/env
      expect(result.enabled).toBe(false)
      expect(result.source).toBe('code')
    })

    it.each([
      'addWallet',
      'createWallet',
      'restoreWallet',
      'discover',
    ] as const)('ships %s on by default in production', (flag) => {
      const result = evaluateFeatureFlag(flag, baseContext)
      expect(result.enabled).toBe(true)
      expect(result.source).toBe('code')
    })
  })

  describe('Layer 2: Platform overrides', () => {
    it('should enable push notifications on mobile', () => {
      const result = evaluateFeatureFlag('pushNotifications', {...baseContext, platform: 'mobile'})
      expect(result.enabled).toBe(true)
      expect(result.source).toBe('platform')
    })

    it('should disable push notifications on web', () => {
      const result = evaluateFeatureFlag('pushNotifications', {
        ...baseContext,
        platform: 'web',
        remoteConfig: undefined,
      })
      // env (production) doesn't set pushNotifications, so platform override (false for web) wins
      expect(result.enabled).toBe(false)
      expect(result.source).toBe('platform')
    })
  })

  describe('Layer 3: Environment overrides', () => {
    it('should enable features in development', () => {
      const result = evaluateFeatureFlag('portfolioChart', {...baseContext, environment: 'development'})
      expect(result.enabled).toBe(true) // dev enables most features
      expect(result.source).toBe('environment')
    })
  })

  describe('Layer 4: Remote config', () => {
    it('should override code defaults with remote config', () => {
      const result = evaluateFeatureFlag('discover', {
        ...baseContext,
        // discover ships on via CODE_DEFAULTS
        remoteConfig: {discover: false}, // but remote disables it
      })
      expect(result.enabled).toBe(false)
      expect(result.source).toBe('remote')
    })

    it('should apply remote config rollout percentage', () => {
      const result = evaluateFeatureFlag('portfolioChart', {
        ...baseContext,
        remoteConfig: {
          portfolioChart: {enabled: true, rolloutPercentage: 0},
        },
      })
      expect(result.enabled).toBe(false) // 0% rollout
      expect(result.source).toBe('remote')
    })
  })

  describe('Layer 5: Runtime overrides', () => {
    it('should override everything with runtime override', () => {
      const result = evaluateFeatureFlag('discover', {
        ...baseContext,
        remoteConfig: {discover: true}, // remote enables
        runtimeOverrides: [{flagId: 'discover', enabled: false, setAt: Date.now()}], // runtime disables
      })
      expect(result.enabled).toBe(false)
      expect(result.source).toBe('runtime')
    })

    it('should ignore expired runtime overrides', () => {
      const result = evaluateFeatureFlag('discover', {
        ...baseContext,
        runtimeOverrides: [
          {
            flagId: 'discover',
            enabled: false,
            setAt: Date.now() - 1000,
            expiresAt: Date.now() - 500, // expired 500ms ago
          },
        ],
      })
      expect(result.enabled).toBe(true) // falls through to code default
      expect(result.source).toBe('code')
    })

    it('should use non-expired runtime overrides', () => {
      const result = evaluateFeatureFlag('discover', {
        ...baseContext,
        runtimeOverrides: [
          {
            flagId: 'discover',
            enabled: false,
            setAt: Date.now(),
            expiresAt: Date.now() + 60000, // expires in 1 minute
          },
        ],
      })
      expect(result.enabled).toBe(false)
      expect(result.source).toBe('runtime')
    })
  })

  describe('Precedence chain', () => {
    it('should follow full precedence: runtime > remote > environment > platform > code', () => {
      // Test that runtime beats all
      const withRuntime = evaluateFeatureFlag('discover', {
        platform: 'mobile',
        environment: 'development', // enables
        installationId: 'test',
        buildNumber: 1,
        runtimeOverrides: [{flagId: 'discover', enabled: false, setAt: Date.now()}], // disables
        remoteConfig: {discover: true}, // enables
      })
      expect(withRuntime.enabled).toBe(false)
      expect(withRuntime.source).toBe('runtime')

      // Test that remote beats env/platform/code
      const withRemote = evaluateFeatureFlag('discover', {
        platform: 'mobile',
        environment: 'development', // enables
        installationId: 'test',
        buildNumber: 1,
        runtimeOverrides: [],
        remoteConfig: {discover: false}, // disables
      })
      expect(withRemote.enabled).toBe(false)
      expect(withRemote.source).toBe('remote')

      // Test that the code default ships discover on with no higher layer applying
      const withCodeDefault = evaluateFeatureFlag('discover', {
        platform: 'mobile',
        environment: 'production', // doesn't override
        installationId: 'test',
        buildNumber: 1,
        runtimeOverrides: [],
        remoteConfig: undefined,
      })
      expect(withCodeDefault.enabled).toBe(true)
      expect(withCodeDefault.source).toBe('code')
    })
  })
})
