const {withAndroidManifest} = require('@expo/config-plugins')

function hasName(entries, expectedValue) {
  return (entries ?? []).some((entry) => entry.$?.['android:name'] === expectedValue)
}

function isLauncherActivity(activity) {
  return (activity['intent-filter'] ?? []).some((intentFilter) => {
    return (
      hasName(intentFilter.action, 'android.intent.action.MAIN') &&
      hasName(intentFilter.category, 'android.intent.category.LAUNCHER')
    )
  })
}

module.exports = function withMainActivityLaunchMode(config) {
  return withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application?.[0]
    const activities = app?.activity ?? []
    const mainActivity =
      activities.find(isLauncherActivity) ??
      activities.find((activity) => activity.$?.['android:name'] === '.MainActivity')

    if (!mainActivity?.$) {
      throw new Error('Unable to find Android main activity to set launchMode')
    }

    mainActivity.$['android:launchMode'] = 'singleTop'

    return config
  })
}
