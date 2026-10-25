/**
 * Dev-only state-clearing actions exposed to the LOG overlay (React Native).
 *
 * Surface mirrors the web variant in `dev-actions.ts`.
 *
 * @module
 */

import * as SQLite from 'expo-sqlite'
import {Alert, DevSettings} from 'react-native'
import * as Keychain from 'react-native-keychain'
import {createMMKV} from 'react-native-mmkv'
import {logger} from '../logger'
import {storage} from '../platform/storage'

const NETWORKS = ['mainnet', 'testnet', 'preprod', 'preview'] as const

// Key formats must mirror production. Bare strings on purpose — pulling the
// real services would drag Effect/Layer wiring into a dev-only path.
// See: app/src/services/credential-vault/enclave-vault.ts.
const ENCLAVE_MNEMONIC_PREFIX = '@pnyx/mnemonic/'

async function clearSecureStore() {
  // Enclave keychain entries: react-native-keychain exposes a list API, so
  // wipe by service-prefix match — catches orphans the groups index missed.
  try {
    const services = await Keychain.getAllGenericPasswordServices()
    const ours = services.filter((s) => s.startsWith(ENCLAVE_MNEMONIC_PREFIX))
    for (const service of ours) {
      try {
        await Keychain.resetGenericPassword({service})
      } catch (e) {
        logger.warn('Keychain reset failed', {origin: 'DevWipe', service, error: e})
      }
    }
    logger.info('Keychain enclave entries cleared', {origin: 'DevWipe', count: ours.length})
  } catch (e) {
    logger.warn('Failed to enumerate keychain services for enclave cleanup', {origin: 'DevWipe', error: e})
  }
}

async function clearSQLiteDatabases() {
  try {
    for (const network of NETWORKS) {
      try {
        await SQLite.deleteDatabaseAsync(`pnyx-${network}.db`)
      } catch (e: unknown) {
        logger.debug('Dev wipe could not delete a database', {
          origin: 'dev-actions.native',
          network,
          error: String(e),
        })
      }
    }
  } catch (e) {
    logger.warn('SQLite clear failed', {origin: 'DevWipe', error: e})
  }
}

export async function wipeAllStorage() {
  await clearSecureStore()
  await clearSQLiteDatabases()
  const allKeys = await storage.getAllKeys()
  if (allKeys.length > 0) {
    await storage.multiRemove(allKeys)
  }
  try {
    const pnyxStorage = createMMKV({id: 'pnyx'})
    pnyxStorage.clearAll()
  } catch (e) {
    logger.warn('pnyx MMKV clear failed', {origin: 'DevWipe', error: e})
  }
  logger.info('All storage wiped', {origin: 'DevWipe', settingsKeysCleared: allKeys.length})
}

export function reloadApp() {
  // Brief delay so MMKV/SQLite file handles close before reload
  setTimeout(() => DevSettings.reload(), 100)
}

/** Promise-based confirm built on the native Alert.alert dialog. */
export function confirmDialog({
  title,
  message,
  confirmLabel,
}: {
  title: string
  message: string
  confirmLabel: string
}): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      {text: 'Cancel', style: 'cancel', onPress: () => resolve(false)},
      {text: confirmLabel, style: 'destructive', onPress: () => resolve(true)},
    ])
  })
}
