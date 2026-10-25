const {withProjectBuildGradle} = require('@expo/config-plugins')

/**
 * Forces the Kotlin Gradle plugin version on the root buildscript classpath.
 *
 * `@react-native/gradle-plugin` pins `kotlin = "2.1.20"` in its own version catalog and declares
 * KGP as an `implementation` dependency. It is pulled in as an `includeBuild` composite, so the
 * app's version catalog cannot reach it, and the unversioned
 * `classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')` in the generated root `build.gradle`
 * takes its version from that graph.
 *
 * `expo-build-properties`' `android.kotlinVersion` does not move it. That property flows through
 * `expoLibs` into `rootProject.ext.kotlinVersion`, which only feeds *subproject* buildscript
 * declarations — and Gradle loads buildscript classes parent-first, so `org.jetbrains.kotlin.gradle.*`
 * always resolves from the root classloader no matter what version a subproject asks for. Setting
 * it alone is worse than a no-op: it does successfully move `ext.kspVersion`, desynchronising KSP
 * from the compiler for the three modules that apply it (expo-image, expo-updates, async-storage).
 *
 * So the version has to be forced here, and `android.kotlinVersion` must be set to the same value
 * in `app.config.js` to keep the subprojects and KSP coherent with it.
 *
 * 2.2.21 is the lowest version that can read the Kotlin 2.3 metadata shipped by
 * `com.google.mlkit:genai-*` beta4 (a 2.1.x compiler reads at most 2.2.0).
 */
const KOTLIN_VERSION = '2.2.21'

const FORCE_MARKER = "details.requested.group == 'org.jetbrains.kotlin'"
const EXISTING_VERSION_RE = /(details\.useVersion ')[^']*(')/

const forceBlock = `
  // KGP arrives unversioned from @react-native/gradle-plugin's catalog, and buildscript classes
  // load parent-first — a subproject asking for a newer Kotlin is silently shadowed.
  configurations.classpath {
    resolutionStrategy.eachDependency { details ->
      if (${FORCE_MARKER}) {
        details.useVersion '${KOTLIN_VERSION}'
      }
    }
  }
`

function forceKotlinVersion(buildGradle) {
  // A non-`--clean` prebuild runs against a build.gradle this plugin already edited.
  if (buildGradle.includes(FORCE_MARKER)) {
    return buildGradle.replace(EXISTING_VERSION_RE, `$1${KOTLIN_VERSION}$2`)
  }

  if (!buildGradle.includes('buildscript {')) {
    throw new Error('with-kotlin-version: no buildscript block in the root build.gradle')
  }

  return buildGradle.replace('buildscript {', `buildscript {\n${forceBlock}`)
}

module.exports = function withKotlinVersion(config) {
  return withProjectBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error('with-kotlin-version: expected a Groovy root build.gradle')
    }
    config.modResults.contents = forceKotlinVersion(config.modResults.contents)
    return config
  })
}

module.exports.KOTLIN_VERSION = KOTLIN_VERSION
