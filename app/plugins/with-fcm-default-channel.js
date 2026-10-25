const {withAndroidManifest} = require('@expo/config-plugins')

/**
 * Point FCM at our notification channel for notifications the OS displays itself.
 *
 * ⚠️ **A backgrounded app's banner is drawn by Android, not by our JS.** Without this metadata FCM
 * logs `Missing Default Notification Channel metadata in AndroidManifest. Default value will be
 * used.` and falls back to a channel we never configured — so the channel `setupNotifee` creates
 * (importance HIGH, sound, heads-up) applies only to notifications displayed while the app is in the
 * foreground, and every push that arrives while it is closed renders at whatever the default gives.
 *
 * ⚠️ Must equal `NOTIFEE_CHANNEL_ID` in `src/platform/notifee-setup.ts`. A manifest cannot import it,
 * so `with-fcm-default-channel.test.ts` asserts the two agree.
 */
const CHANNEL_ID = 'pnyx_push'

const META_NAME = 'com.google.firebase.messaging.default_notification_channel_id'

/**
 * The manifest edit itself, separated from expo's plugin host so it can be tested without one.
 * Mutates and returns the same AST expo hands us.
 */
function applyFcmDefaultChannel(manifest) {
  const application = manifest?.manifest?.application?.[0]
  if (application === undefined) {
    throw new Error('with-fcm-default-channel: no <application> in the manifest')
  }
  application['meta-data'] = application['meta-data'] ?? []
  const existing = application['meta-data'].find((entry) => entry.$?.['android:name'] === META_NAME)
  if (existing) {
    existing.$['android:value'] = CHANNEL_ID
    existing.$['tools:replace'] = 'android:value'
    return manifest
  }
  // ⚠️ `tools:replace` is not optional: `react-native-firebase/messaging` ships this same meta-data
  // with an **empty** value, and the manifest merger fails the build on two declarations of one
  // attribute rather than picking. Ours is the one that names a channel that exists.
  application['meta-data'].push({
    $: {'android:name': META_NAME, 'android:value': CHANNEL_ID, 'tools:replace': 'android:value'},
  })
  return manifest
}

const withFcmDefaultChannel = (config) =>
  withAndroidManifest(config, (cfg) => {
    applyFcmDefaultChannel(cfg.modResults)
    return cfg
  })

module.exports = withFcmDefaultChannel
module.exports.applyFcmDefaultChannel = applyFcmDefaultChannel
module.exports.CHANNEL_ID = CHANNEL_ID
module.exports.META_NAME = META_NAME
