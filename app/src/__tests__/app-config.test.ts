import * as fs from 'node:fs'
import {createRequire} from 'node:module'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

const _require = createRequire(import.meta.url)
const APP_CONFIG_PATH = path.resolve(import.meta.dirname, '../../app.config.js')

const PNYX_IOS_BUNDLE_ID = 'uk.pxkq.pnyx'
const PNYX_ANDROID_PACKAGE = 'uk.pxkq.pnyx'

function loadConfig() {
  delete _require.cache[APP_CONFIG_PATH]
  return _require(APP_CONFIG_PATH).expo
}

describe('app.config.js', () => {
  beforeEach(() => {
    process.env.PNYX_BUILD_VARIANT = 'prod'
  })

  afterEach(() => {
    delete process.env.PNYX_BUILD_VARIANT
  })

  describe('native identity', () => {
    it('uses pnyx bundle identifiers', () => {
      const config = loadConfig()
      expect(config.ios.bundleIdentifier).toBe(PNYX_IOS_BUNDLE_ID)
      expect(config.android.package).toBe(PNYX_ANDROID_PACKAGE)
    })

    it('uses the pnyx display name and scheme', () => {
      const config = loadConfig()
      expect(config.name).toBe('Pnyx')
      expect(config.scheme).toBe('pnyx')
    })
  })

  describe('PNYX_BUILD_VARIANT from app/.env fallback', () => {
    const dotEnvPath = path.resolve(import.meta.dirname, '../../.env')

    describe('when process.env.PNYX_BUILD_VARIANT is unset', () => {
      let previous: string | null | undefined

      beforeEach(() => {
        previous = fs.existsSync(dotEnvPath) ? fs.readFileSync(dotEnvPath, 'utf8') : null
        fs.writeFileSync(dotEnvPath, '# test fixture\nPNYX_BUILD_VARIANT=prod\n', 'utf8')
        delete process.env.PNYX_BUILD_VARIANT
      })

      afterEach(() => {
        if (previous == null) {
          fs.rmSync(dotEnvPath, {force: true})
        } else {
          fs.writeFileSync(dotEnvPath, previous, 'utf8')
        }
      })

      // `prod` because it is distinguishable from the no-variant default (`dev`): a fixture value
      // that happens to equal the default would pass whether or not the .env fallback ran.
      it('uses the variant from .env so extra.appEnv matches on-disk env', () => {
        const config = loadConfig()
        expect(config.extra.appEnv).toBe('prod')
      })
    })

    it('prefers process.env.PNYX_BUILD_VARIANT over .env when both are set', () => {
      const previousVariant = process.env.PNYX_BUILD_VARIANT
      const previousDotEnv = fs.existsSync(dotEnvPath) ? fs.readFileSync(dotEnvPath, 'utf8') : null
      try {
        fs.writeFileSync(dotEnvPath, 'PNYX_BUILD_VARIANT=devclient\n', 'utf8')
        process.env.PNYX_BUILD_VARIANT = 'prod'
        const config = loadConfig()
        // `devclient` would resolve to appEnv 'dev', so 'prod' can only come from process.env.
        expect(config.extra.appEnv).toBe('prod')
      } finally {
        if (previousVariant === undefined) {
          delete process.env.PNYX_BUILD_VARIANT
        } else {
          process.env.PNYX_BUILD_VARIANT = previousVariant
        }
        if (previousDotEnv === null) {
          fs.rmSync(dotEnvPath, {force: true})
        } else {
          fs.writeFileSync(dotEnvPath, previousDotEnv, 'utf8')
        }
      }
    })
  })

  // Preview builds are prod-shaped (buildVariant='prod' for bundle IDs / icons)
  // but tag themselves preview via PNYX_APP_ENV. The two axes must stay
  // independent: the dev-tools gate keys off `appEnv === 'prod'`, so a preview
  // build (appEnv='preview') keeps developer options while the build-identity
  // axis stays prod-shaped for bundle ID / icon purposes.
  describe('preview build (prod-shaped, PNYX_APP_ENV=preview)', () => {
    let previousAppEnv: string | undefined

    beforeEach(() => {
      process.env.PNYX_BUILD_VARIANT = 'prod'
      previousAppEnv = process.env.PNYX_APP_ENV
      process.env.PNYX_APP_ENV = 'preview'
    })

    afterEach(() => {
      if (previousAppEnv === undefined) {
        delete process.env.PNYX_APP_ENV
      } else {
        process.env.PNYX_APP_ENV = previousAppEnv
      }
    })

    it('reports appEnv=preview so the dev-tools gate stays open', () => {
      const config = loadConfig()
      expect(config.extra.appEnv).toBe('preview')
      expect(config.extra.appEnv === 'prod').toBe(false)
    })

    it('keeps unsuffixed prod bundle ids for the build-identity axis', () => {
      const config = loadConfig()
      expect(config.ios.bundleIdentifier).toBe('uk.pxkq.pnyx')
      expect(config.android.package).toBe('uk.pxkq.pnyx')
    })
  })
})
