const {withDangerousMod} = require('@expo/config-plugins')
const fs = require('node:fs')
const path = require('node:path')

// Matches any pre-existing `maven { url "<…>@notifee/react-native/android/libs" }`
// line — covers the relative `$rootDir/../node_modules/...` form written by
// earlier versions of this plugin as well as any prior absolute-path write.
const EXISTING_NOTIFEE_REPO_RE = /^[ \t]*maven\s*\{\s*url\s*"[^"]*@notifee\/react-native\/android\/libs"\s*\}\s*\r?\n/m

function addNotifeeRepo(buildGradle, projectRoot) {
  // Resolve notifee's real install location so the maven repo path is correct
  // regardless of node_modules layout (hoisted monorepo-root vs app-local).
  const notifeePkg = require.resolve('@notifee/react-native/package.json', {paths: [projectRoot]})
  const libsDir = path.join(path.dirname(notifeePkg), 'android', 'libs').replace(/\\/g, '/')
  const snippet = `    maven { url "${libsDir}" }\n`

  const existing = buildGradle.match(EXISTING_NOTIFEE_REPO_RE)
  if (existing) {
    // Replace stale entries (e.g. an older `$rootDir/../node_modules/...` write
    // left behind by a previous plugin version) so the path always reflects
    // the current resolution. Skip when the entry already points at the same
    // absolute libsDir to avoid no-op rewrites and gradle re-syncs.
    if (existing[0].includes(`"${libsDir}"`)) return buildGradle
    return buildGradle.replace(EXISTING_NOTIFEE_REPO_RE, snippet)
  }

  // Insert after jitpack line
  return buildGradle.replace(
    `maven { url 'https://www.jitpack.io' }`,
    `maven { url 'https://www.jitpack.io' }\n${snippet}`,
  )
}

module.exports = function withNotifeeAndroidMaven(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const buildGradlePath = path.join(config.modRequest.platformProjectRoot, 'build.gradle')
      const contents = fs.readFileSync(buildGradlePath, 'utf-8')
      fs.writeFileSync(buildGradlePath, addNotifeeRepo(contents, config.modRequest.projectRoot))
      return config
    },
  ])
}
