import {describe, expect, it} from 'vitest'
import {APP_ENVS, ENV_MANIFEST, envSpec, isRequiredIn, validateEnvVars} from './env-manifest'

/** A complete set, so each test can remove exactly one thing and assert only that is reported. */
const complete = (): Record<string, string> => ({
  EXPO_PUBLIC_SERVICE_URL: 'https://service.example',
  EXPO_PUBLIC_PNYX_NETWORK: 'preprod',
  EXPO_PUBLIC_ARTIFACTS_URL: 'https://artifacts.example',
  EXPO_PUBLIC_REMOTE_CONFIG_URL: 'https://config.example',
})

const names = (problems: ReturnType<typeof validateEnvVars>) => problems.map((problem) => problem.name)

describe('validateEnvVars', () => {
  it('passes a complete environment', () => {
    expect(validateEnvVars('prod', complete())).toEqual([])
  })

  it('reports every missing required variable at once, not just the first', () => {
    // Fixing a fresh env file one build at a time is the experience this replaces.
    const problems = validateEnvVars('prod', {})
    expect(names(problems).sort()).toEqual([
      'EXPO_PUBLIC_ARTIFACTS_URL',
      'EXPO_PUBLIC_PNYX_NETWORK',
      'EXPO_PUBLIC_REMOTE_CONFIG_URL',
      'EXPO_PUBLIC_SERVICE_URL',
    ])
    expect(problems.every((problem) => problem.reason === 'missing')).toBe(true)
  })

  it('separates "set but empty" from "unset" — they are different mistakes', () => {
    // `FOO=` is someone believing they disabled something that is not optional.
    const problems = validateEnvVars('prod', {...complete(), EXPO_PUBLIC_SERVICE_URL: '   '})
    expect(problems).toHaveLength(1)
    expect(problems[0]?.reason).toBe('empty')
  })

  it('accepts an empty optional — that is what disabling Sentry looks like', () => {
    expect(validateEnvVars('prod', {...complete(), EXPO_PUBLIC_SENTRY_DSN: ''})).toEqual([])
  })

  it('rejects a value outside an enum', () => {
    const problems = validateEnvVars('prod', {...complete(), EXPO_PUBLIC_PNYX_NETWORK: 'mainnnet'})
    expect(problems).toHaveLength(1)
    expect(problems[0]?.reason).toBe('not-allowed')
  })

  it('rejects a non-absolute URL, including the bare host an env file invites', () => {
    for (const bad of ['service.example', 'localhost:3300', 'ftp://x.example', '/chain']) {
      const problems = validateEnvVars('prod', {...complete(), EXPO_PUBLIC_SERVICE_URL: bad})
      expect(names(problems), bad).toEqual(['EXPO_PUBLIC_SERVICE_URL'])
      expect(problems[0]?.reason).toBe('not-a-url')
    }
  })

  it('checks the shape of an optional too — a typo is still a typo', () => {
    // Otherwise it surfaces as a failed fetch at runtime instead of at build time.
    const problems = validateEnvVars('prod', {...complete(), EXPO_PUBLIC_KRAKEN_URL: 'not a url'})
    expect(names(problems)).toEqual(['EXPO_PUBLIC_KRAKEN_URL'])
  })

  it('flags a variable nothing reads, which is usually a rename that lost its call site', () => {
    const problems = validateEnvVars('prod', {...complete(), EXPO_PUBLIC_AGORA_NETWORK: 'preprod'})
    expect(problems).toHaveLength(1)
    expect(problems[0]?.reason).toBe('unknown-variable')
  })

  it('requires the deployment-identity set in every gated variant', () => {
    // The production file having none of these, with nothing reporting it, is why this exists.
    for (const appEnv of APP_ENVS) {
      expect(names(validateEnvVars(appEnv, {})).sort(), appEnv).toEqual([
        'EXPO_PUBLIC_ARTIFACTS_URL',
        'EXPO_PUBLIC_PNYX_NETWORK',
        'EXPO_PUBLIC_REMOTE_CONFIG_URL',
        'EXPO_PUBLIC_SERVICE_URL',
      ])
    }
  })

  it('leaves the user-configurable Cardano knobs optional', () => {
    // Runtime-switchable in Settings on a mainnet-capable app, so their in-code defaults are product
    // decisions. Requiring them would also be impossible: one URL cannot serve every network.
    for (const name of ['EXPO_PUBLIC_CARDANO_NETWORK', 'EXPO_PUBLIC_CARDANO_KOIOS_URL']) {
      const spec = envSpec(name)
      expect(spec, name).toBeDefined()
      expect(
        APP_ENVS.some((appEnv) => spec !== undefined && isRequiredIn(spec, appEnv)),
        name,
      ).toBe(false)
    }
  })
})

describe('ENV_MANIFEST', () => {
  it('has no duplicate entries', () => {
    const seen = ENV_MANIFEST.map((spec) => spec.name)
    expect(seen).toHaveLength(new Set(seen).size)
  })

  it('names every variable with the EXPO_PUBLIC_ prefix the bundler substitutes', () => {
    expect(ENV_MANIFEST.filter((spec) => !spec.name.startsWith('EXPO_PUBLIC_'))).toEqual([])
  })
})
