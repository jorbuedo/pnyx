const {withDangerousMod} = require('@expo/config-plugins')
const fs = require('node:fs')
const path = require('node:path')

// RNFirebase ships precompiled xcframeworks (e.g. FirebaseFirestoreInternal).
// Under static frameworks (ios.useFrameworks: 'static') the link step only
// finds them when RNFirebase pods are built as static frameworks too, which
// this global flag turns on. Without it the link fails with
// "framework 'FirebaseFirestoreInternal' not found".
const STATIC_FRAMEWORK_FLAG = '$RNFirebaseAsStaticFramework = true'

function addStaticFrameworkFlag(podfile) {
  if (podfile.includes(STATIC_FRAMEWORK_FLAG)) return podfile

  // Place it before the main target block as a top-level global.
  const targetRegex = /target\s+'[^']+'\s+do/
  const match = podfile.match(targetRegex)
  if (!match) return podfile

  return `${podfile.slice(0, match.index)}${STATIC_FRAMEWORK_FLAG}\n\n${podfile.slice(match.index)}`
}

function addFirebaseModularPods(podfile) {
  // Only the pods RNFB app+messaging actually pull in. Do NOT add FirebaseFirestore /
  // FirebaseFirestoreInternal here: no JS package uses them, and without
  // ios.useFrameworks their podspec's `-weak_framework FirebaseFirestoreInternal`
  // user flag has no framework product to resolve against, failing the app link.
  const snippet = `
  # Firebase / Google pods need modules when using static frameworks
  pod 'GoogleUtilities', :modular_headers => true
  pod 'FirebaseCore', :modular_headers => true
  pod 'FirebaseCoreInternal', :modular_headers => true
  pod 'FirebaseMessaging', :modular_headers => true
`

  // find the main target start, usually: target 'App' do / target '<AppName>' do
  const targetRegex = /target\s+'[^']+'\s+do/
  const match = podfile.match(targetRegex)
  if (!match) return podfile // do nothing if structure is unexpected

  const idx = match.index + match[0].length
  return podfile.slice(0, idx) + snippet + podfile.slice(idx)
}

module.exports = function withFirebaseModularHeaders(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile')
      const contents = fs.readFileSync(podfilePath, 'utf-8')
      const newContents = addFirebaseModularPods(addStaticFrameworkFlag(contents))
      fs.writeFileSync(podfilePath, newContents)
      return config
    },
  ])
}
