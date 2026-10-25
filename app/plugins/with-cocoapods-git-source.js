const {withDangerousMod} = require('@expo/config-plugins')
const fs = require('node:fs')
const path = require('node:path')

const SOURCES = ["source 'https://github.com/CocoaPods/Specs.git'"]

/**
 * Ensures CocoaPods source lines are present in the Podfile.
 *
 * - CocoaPods/Specs.git — avoids CDN 429 rate limits on EAS Build
 */
module.exports = function withCocoapodsGitSource(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile')

      if (!fs.existsSync(podfilePath)) return config

      const contents = fs.readFileSync(podfilePath, 'utf-8')

      const missing = SOURCES.filter((s) => !contents.includes(s))
      if (missing.length === 0) return config

      // Find insertion point after initial comments, requires, and empty lines
      const lines = contents.split('\n')
      let insertIndex = 0
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()
        if (
          line.startsWith('#') ||
          line.startsWith('require') ||
          line === '' ||
          line.startsWith('platform') ||
          line.startsWith('source')
        ) {
          insertIndex = i + 1
        } else {
          break
        }
      }

      lines.splice(insertIndex, 0, ...missing, '')
      fs.writeFileSync(podfilePath, lines.join('\n'))
      return config
    },
  ])
}
