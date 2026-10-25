import {describe, expect, it} from 'vitest'

import {getSentryEnvironment} from './sentry-environment'

describe('getSentryEnvironment', () => {
  it('uses development for dev runtimes', () => {
    expect(getSentryEnvironment({isDev: true, appEnv: 'preview', buildVariant: 'prod'})).toBe('development')
  })

  it.each([
    ['dev', 'dev'],
    ['devclient', 'dev'],
    ['preview', 'preview'],
    ['prod', 'production'],
    ['production', 'production'],
  ] as const)('normalizes build environment %s to Sentry environment %s', (input, expected) => {
    expect(getSentryEnvironment({isDev: false, appEnv: input})).toBe(expected)
  })

  it('falls back to the extension build variant when Expo appEnv is unavailable', () => {
    expect(getSentryEnvironment({isDev: false, buildVariant: 'devclient'})).toBe('dev')
  })

  it('omits the environment when the build metadata is unavailable', () => {
    expect(getSentryEnvironment({isDev: false})).toBeUndefined()
  })
})
