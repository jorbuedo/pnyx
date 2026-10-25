const {withGradleProperties} = require('@expo/config-plugins')

/**
 * Raises the Gradle daemon heap.
 *
 * The Expo template ships `org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m`. This app's
 * external dex input is large enough that `:app:mergeExtDexDebug` exhausts that heap and D8 dies
 * with `java.lang.OutOfMemoryError: Java heap space` — the build fails outright, so this is not a
 * tuning nicety.
 *
 * It lives in a plugin because `expo prebuild --clean` regenerates `android/gradle.properties`,
 * and `expo-build-properties` exposes no gradle-property escape hatch (its android options cover
 * SDK/NDK versions, Proguard, packaging and Maven repos — not JVM args).
 */
const JVM_ARGS = '-Xmx6144m -XX:MaxMetaspaceSize=1024m'

module.exports = function withGradleJvmHeap(config) {
  return withGradleProperties(config, (config) => {
    const properties = config.modResults.filter(
      (item) => !(item.type === 'property' && item.key === 'org.gradle.jvmargs'),
    )
    properties.push({type: 'property', key: 'org.gradle.jvmargs', value: JVM_ARGS})
    config.modResults = properties
    return config
  })
}
