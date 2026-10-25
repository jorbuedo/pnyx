const {withDangerousMod} = require('@expo/config-plugins')
const fs = require('node:fs')
const path = require('node:path')

const MARKER = '# Raise every pod below our minimum.'

/**
 * Raise each pod target's `IPHONEOS_DEPLOYMENT_TARGET` to the Podfile's platform.
 *
 * `expo-build-properties`' `ios.deploymentTarget` moves the app target and the Podfile's
 * `platform :ios` line, but CocoaPods gives a pod's generated resource-bundle target the *pod's
 * own* declared minimum — 9.0 for PromisesObjC and SDWebImage, 11.0 for Sentry, 12.0 for
 * GoogleUtilities and nanopb. Xcode 27 refuses to build below 15.0, so those targets fail the
 * build outright. Only values below ours are raised; a pod asking for more keeps it.
 */
function bumpLines(indent) {
  return [
    `${indent}${MARKER}`,
    `${indent}minimum = Gem::Version.new(podfile_properties['ios.deploymentTarget'] || '15.1')`,
    `${indent}installer.pods_project.targets.each do |pod_target|`,
    `${indent}  pod_target.build_configurations.each do |build_configuration|`,
    `${indent}    declared = build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET']`,
    `${indent}    next if declared.nil? || Gem::Version.new(declared) >= minimum`,
    `${indent}    build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = minimum.to_s`,
    `${indent}  end`,
    `${indent}end`,
  ]
}

/**
 * Insert the bump at the end of the Podfile's existing `post_install` block.
 *
 * The end rather than the start: `react_native_post_install` also rewrites build settings, so a
 * bump placed before it can be undone. CocoaPods allows one `post_install` per Podfile, which is
 * why this edits the block instead of adding another.
 */
function injectPodsDeploymentTarget(contents) {
  if (contents.includes(MARKER)) return contents

  const lines = contents.split('\n')
  const open = lines.findIndex((line) => /^\s*post_install do \|installer\|\s*$/.test(line))
  if (open === -1) throw new Error('with-pods-deployment-target: no `post_install do |installer|` block in the Podfile')

  const indent = /^(\s*)/.exec(lines[open])[1]
  const closes = new RegExp(`^${indent}end\\s*$`)
  const close = lines.findIndex((line, i) => i > open && closes.test(line))
  if (close === -1) throw new Error('with-pods-deployment-target: the `post_install` block is not closed at its indent')

  lines.splice(close, 0, ...bumpLines(`${indent}  `))
  return lines.join('\n')
}

module.exports = function withPodsDeploymentTarget(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile')
      if (!fs.existsSync(podfilePath)) return config
      fs.writeFileSync(podfilePath, injectPodsDeploymentTarget(fs.readFileSync(podfilePath, 'utf-8')))
      return config
    },
  ])
}

module.exports.MARKER = MARKER
module.exports.injectPodsDeploymentTarget = injectPodsDeploymentTarget
