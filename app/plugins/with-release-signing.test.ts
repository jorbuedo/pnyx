import {createRequire} from 'node:module'
import {describe, expect, it} from 'vitest'

const plugin = createRequire(import.meta.url)('./with-release-signing') as {
  MARKER: string
  MISSING_MESSAGE: string
  injectReleaseSigning: (contents: string) => string
}

/** The shape `expo prebuild` generates, trimmed to the blocks the plugin edits. */
const BUILD_GRADLE = `apply plugin: "com.android.application"

android {
    namespace 'uk.pxkq.pnyx'
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}
`

const injected = plugin.injectReleaseSigning(BUILD_GRADLE)

/** The body of the `release` build type, which is the only `signingConfig` allowed to move. */
function releaseBuildType(contents: string): string {
  const buildTypes = contents.indexOf('buildTypes {')
  const release = contents.indexOf('release {', buildTypes)
  return contents.slice(release, contents.indexOf('\n        }', release))
}

function debugBuildType(contents: string): string {
  const buildTypes = contents.indexOf('buildTypes {')
  const debug = contents.indexOf('debug {', buildTypes)
  return contents.slice(debug, contents.indexOf('\n        }', debug))
}

describe('with-release-signing', () => {
  it('points the release build type away from the debug key', () => {
    expect(releaseBuildType(BUILD_GRADLE)).toContain('signingConfig signingConfigs.debug')
    expect(releaseBuildType(injected)).not.toContain('signingConfigs.debug')
    expect(releaseBuildType(injected)).toContain('signingConfigs.release')
  })

  it('leaves the debug build type signed by the debug key', () => {
    // Both build types declare the same line; a plain string replace would move this one too.
    expect(debugBuildType(injected)).toContain('signingConfig signingConfigs.debug')
  })

  it('reads every credential from a gradle property, never a literal', () => {
    for (const property of [
      'PNYX_RELEASE_STORE_FILE',
      'PNYX_RELEASE_STORE_PASSWORD',
      'PNYX_RELEASE_KEY_ALIAS',
      'PNYX_RELEASE_KEY_PASSWORD',
    ]) {
      expect(injected).toContain(`findProperty('${property}')`)
    }
  })

  it('carries no credential and no home path of its own', () => {
    // Scoped to the block the plugin adds: the template's own debug config keeps its literals.
    const added = injected.slice(injected.indexOf('if (pnyxReleaseSigning) {'), injected.indexOf('buildTypes {'))
    expect(added).not.toMatch(/\/home\/|\/Users\//)
    expect(added).not.toMatch(/storePassword\s+'/)
    expect(added).not.toMatch(/keyPassword\s+'/)
    expect(injected).not.toContain('pnyx-release.p12')
  })

  it('leaves the braces balanced and the closing line of signingConfigs intact', () => {
    // A block inserted at the closing brace rather than at the start of its line swallows that
    // line's indentation, which parses but reads as corruption.
    const open = (injected.match(/\{/g) ?? []).length
    const close = (injected.match(/\}/g) ?? []).length
    expect(open).toBe(close)
    expect(injected).toContain('\n            }\n        }\n    }\n    buildTypes {')
  })

  it('fails a release build rather than falling back to the debug key', () => {
    // The whole point: an unconfigured machine must not quietly produce a debug-signed release.
    expect(injected).toContain('throw new GradleException')
    expect(injected).toContain(plugin.MISSING_MESSAGE)
    expect(injected).toContain("it.name.endsWith('Release')")
  })

  it('keeps a debug build working on a machine with no signing properties', () => {
    // `findProperty` (not a bare reference) and a guarded config, or `assembleDebug` dies at
    // configuration time on every machine that has not set the properties.
    expect(injected).not.toMatch(/^\s*storeFile file\(PNYX_/m)
    expect(injected).toContain('if (pnyxReleaseSigning) {')
    expect(releaseBuildType(injected)).toContain('pnyxReleaseSigning ? signingConfigs.release : null')
  })

  it('declares the store type, so a JDK defaulting to JKS still reads a PKCS12 keystore', () => {
    expect(injected).toContain("storeType findProperty('PNYX_RELEASE_STORE_TYPE') ?: 'PKCS12'")
  })

  it('is idempotent, because prebuild without --clean re-runs over an edited build.gradle', () => {
    expect(plugin.injectReleaseSigning(injected)).toBe(injected)
  })

  it('throws rather than silently skipping when an anchor it targets is gone', () => {
    // An Expo template change that drops a block must fail the build, not ship an unsigned APK.
    expect(() => plugin.injectReleaseSigning('android {\n}\n')).toThrow(/signingConfigs/)
    expect(() => plugin.injectReleaseSigning(BUILD_GRADLE.replace('android {', 'somethingElse {'))).toThrow(
      /android block/,
    )
    expect(() => plugin.injectReleaseSigning(BUILD_GRADLE.replace(/buildTypes/, 'otherTypes'))).toThrow(/buildTypes/)
  })
})
