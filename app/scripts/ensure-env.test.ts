import {describe, expect, it} from 'vitest'
import {appEnvFileVars, parseEnvFile, readAppEnvFileVars} from './ensure-env'

describe('parseEnvFile', () => {
  it('reads KEY=value lines and ignores comments and blanks', () => {
    expect(
      parseEnvFile(
        ['# a comment', '', 'EXPO_PUBLIC_SERVICE_URL=https://pnyx.pxkq.uk', '   # indented comment'].join('\n'),
      ),
    ).toEqual({EXPO_PUBLIC_SERVICE_URL: 'https://pnyx.pxkq.uk'})
  })

  it('keeps an empty assignment, which is how Sentry is disabled', () => {
    expect(parseEnvFile('EXPO_PUBLIC_SENTRY_DSN=')).toEqual({EXPO_PUBLIC_SENTRY_DSN: ''})
  })

  it('keeps `=` inside a value', () => {
    expect(parseEnvFile('EXPO_PUBLIC_TOKEN=ab.cd=ef')).toEqual({EXPO_PUBLIC_TOKEN: 'ab.cd=ef'})
  })

  it('strips surrounding quotes but not inner ones', () => {
    expect(parseEnvFile(`A="x y"\nB='z'\nC=he"llo`)).toEqual({A: 'x y', B: 'z', C: 'he"llo'})
  })

  it('skips a line with no key', () => {
    expect(parseEnvFile('=orphan\nA=1')).toEqual({A: '1'})
  })
})

describe('appEnvFileVars', () => {
  it('gives a preview build the backend it must be built against', () => {
    // The real tracked file, not a fixture: the bug this guards is the file existing while nothing
    // read it, so the test has to prove the actual values reach a build.
    const vars = appEnvFileVars('preview')
    expect(vars.EXPO_PUBLIC_SERVICE_URL).toBe('https://pnyx.pxkq.uk')
    expect(vars.EXPO_PUBLIC_PNYX_NETWORK).toBe('preprod')
  })

  it('leaves dev alone — its file is the template for a hand-tuned local .env', () => {
    expect(readAppEnvFileVars('dev')).toEqual({})
  })

  it('returns nothing for a variant with no file rather than inventing values', () => {
    expect(readAppEnvFileVars('nonsense')).toEqual({})
  })

  // The reader above says what a file contains; `appEnvFileVars` is the build's gate on top of it.
  // `prod` is the real case: env/.env.production deliberately declares none of the required set until
  // production infrastructure exists, and building it used to succeed and embed the fallbacks.
  it('refuses to build a variant whose file does not declare the required set', () => {
    expect(() => appEnvFileVars('prod')).toThrow(/environment incomplete for --env=prod/)
  })

  // An unrecognised appEnv requires nothing, so it cannot be gated — the caller validating its own
  // flag is what catches a typo there (`env-check.ts` rejects it outright).
  it('does not invent requirements for an unknown variant', () => {
    expect(appEnvFileVars('nonsense')).toEqual({})
  })
})
