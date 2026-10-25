const {withAppDelegate} = require('@expo/config-plugins')

/**
 * iOS counterpart to with-android-disable-backup: keeps wallet data out of
 * iCloud / iTunes (Finder) backups.
 *
 * iOS has no static manifest flag like Android's allowBackup. Instead, files
 * under Documents and Application Support are backed up by default unless the
 * NSURLIsExcludedFromBackupKey resource value is set on them. We set it on those
 * directory roots at launch, which excludes their entire subtree — covering the
 * MMKV stores (incl. `@pnyx/wallet/groups` / `@pnyx/wallet/xpubs`) and the
 * expo-sqlite databases, plus anything created in them later.
 *
 * Encrypted seed material lives in the Keychain (WHEN_UNLOCKED_THIS_DEVICE_ONLY,
 * no iCloud sync), so it is already device-bound and outside this file backup.
 */

const MARKER = 'pnyx-exclude-from-backup'

const CALLS = `    let pnyxBackupFM = FileManager.default
    pnyxExcludeFromBackup(pnyxBackupFM.urls(for: .documentDirectory, in: .userDomainMask).first)
    pnyxExcludeFromBackup(pnyxBackupFM.urls(for: .applicationSupportDirectory, in: .userDomainMask).first)
`

const HELPER = `
// ${MARKER}: keep wallet data (MMKV, SQLite) out of iCloud / iTunes backups.
fileprivate func pnyxExcludeFromBackup(_ url: URL?) {
  guard var url = url else { return }
  do {
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
  } catch {
    NSLog("[${MARKER}] failed to exclude \\(url): \\(error)")
  }
}
`

module.exports = function withIosDisableBackup(config) {
  return withAppDelegate(config, (config) => {
    if (config.modResults.language !== 'swift') {
      throw new Error(`with-ios-disable-backup expects a Swift AppDelegate, got ${config.modResults.language}`)
    }

    let contents = config.modResults.contents
    if (contents.includes(MARKER)) return config

    const anchor = 'return super.application(application, didFinishLaunchingWithOptions: launchOptions)'
    if (!contents.includes(anchor)) {
      throw new Error('with-ios-disable-backup: didFinishLaunching anchor not found in AppDelegate')
    }

    contents = contents.replace(anchor, `${CALLS}\n    ${anchor}`)
    contents = `${contents}\n${HELPER}`

    config.modResults.contents = contents
    return config
  })
}
