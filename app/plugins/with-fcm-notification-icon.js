const {withAndroidManifest, withAndroidColors, withDangerousMod, AndroidConfig} = require('@expo/config-plugins')
const fs = require('node:fs')
const path = require('node:path')

/**
 * Give notifications a real status-bar icon.
 *
 * ⚠️ **Android draws the small icon as a silhouette**: every non-transparent pixel is forced white and
 * only the alpha survives. With no `default_notification_icon` the app icon is used, so a full-colour
 * launcher icon becomes a featureless white blob — the blank dot in the status bar.
 *
 * The shipped drawables are already white-on-transparent, generated from the adaptive icon's alpha, so
 * what is in the repo is what the device shows.
 *
 * The colour only tints the icon on Android 5+; it is the brand primary (`palette.ts primary600`).
 */
const ICON_NAME = 'ic_stat_pnyx'
const COLOR_NAME = 'notification_icon_color'
const COLOR_VALUE = '#5443D6'

const DENSITIES = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']

const ICON_META = 'com.google.firebase.messaging.default_notification_icon'
const COLOR_META = 'com.google.firebase.messaging.default_notification_color'

// ⚠️ `tools:replace` is not optional: `react-native-firebase/messaging` ships both of these meta-data
// entries already, empty, and the manifest merger fails the build on two declarations of one attribute
// rather than choosing between them.
const setMeta = (application, name, value) => {
  application['meta-data'] = application['meta-data'] ?? []
  const existing = application['meta-data'].find((entry) => entry.$?.['android:name'] === name)
  if (existing) {
    existing.$['android:resource'] = value
    existing.$['tools:replace'] = 'android:resource'
    delete existing.$['android:value']
    return
  }
  application['meta-data'].push({
    $: {'android:name': name, 'android:resource': value, 'tools:replace': 'android:resource'},
  })
}

const withIconAssets = (config) =>
  withDangerousMod(config, [
    'android',
    async (cfg) => {
      const source = path.join(cfg.modRequest.projectRoot, 'assets', 'notification')
      const res = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res')
      for (const density of DENSITIES) {
        const from = path.join(source, `${ICON_NAME}-${density}.png`)
        if (!fs.existsSync(from)) {
          // Refuse rather than ship the blob back: a missing drawable makes the manifest point at a
          // resource that does not exist, and the build failure is far from the cause.
          throw new Error(`with-fcm-notification-icon: missing ${from}`)
        }
        const dir = path.join(res, `drawable-${density}`)
        fs.mkdirSync(dir, {recursive: true})
        fs.copyFileSync(from, path.join(dir, `${ICON_NAME}.png`))
      }
      return cfg
    },
  ])

const withIconManifest = (config) =>
  withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0]
    if (application === undefined) {
      throw new Error('with-fcm-notification-icon: no <application> in the manifest')
    }
    setMeta(application, ICON_META, `@drawable/${ICON_NAME}`)
    setMeta(application, COLOR_META, `@color/${COLOR_NAME}`)
    return cfg
  })

const withIconColor = (config) =>
  withAndroidColors(config, (cfg) => {
    cfg.modResults = AndroidConfig.Colors.assignColorValue(cfg.modResults, {
      name: COLOR_NAME,
      value: COLOR_VALUE,
    })
    return cfg
  })

module.exports = (config) => withIconColor(withIconManifest(withIconAssets(config)))
module.exports.ICON_NAME = ICON_NAME
module.exports.COLOR_NAME = COLOR_NAME
module.exports.COLOR_VALUE = COLOR_VALUE
module.exports.DENSITIES = DENSITIES
