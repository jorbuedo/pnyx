/**
 * Dev-only state-clearing actions exposed to the LOG overlay (web/extension).
 *
 * Surface mirrors the React Native variant in `dev-actions.native.ts` so the
 * overlay UI doesn't need to fork by platform.
 *
 * @module
 */

import {logger} from '../logger'
import {isExtension, sendMessage} from '../platform/extension/runtime'
import {storage} from '../platform/storage'

const NETWORKS = ['mainnet', 'testnet', 'preprod', 'preview'] as const

async function clearIndexedDB() {
  if (typeof indexedDB === 'undefined') return
  for (const network of NETWORKS) {
    try {
      indexedDB.deleteDatabase(`pnyx-wallet-${network}`)
    } catch (e: unknown) {
      // Ordinarily "no such database". A real delete failure leaves wallet data behind after a
      // dev wipe that reported success.
      logger.debug('Dev wipe could not delete a database', {origin: 'dev-actions', network, error: String(e)})
    }
  }
}

export async function wipeAllStorage() {
  if (isExtension) {
    await sendMessage({type: 'WIPE_ALL'})
    const allKeys = await storage.getAllKeys()
    if (allKeys.length > 0) {
      await storage.multiRemove(allKeys)
    }
    logger.info('All storage wiped via background WIPE_ALL', {origin: 'DevWipe'})
    return
  }

  await clearIndexedDB()
  const allKeys = await storage.getAllKeys()
  if (allKeys.length > 0) {
    await storage.multiRemove(allKeys)
  }
  logger.info('All storage wiped', {origin: 'DevWipe', keysCleared: allKeys.length})
}

export function reloadApp() {
  window.location.reload()
}

/** Synchronous confirm dialog. Returns true if the user confirms. */
export function confirmDialog({
  title,
  message,
  confirmLabel,
}: {
  title: string
  message: string
  confirmLabel: string
}): Promise<boolean> {
  // RN-web's `Alert.alert` is unreliable across browsers / extension popups;
  // fall back to the native `window.confirm` so the buttons actually fire.
  // `confirmLabel` is shown only as part of the message because `confirm`
  // doesn't expose button labels.
  const fullMessage = `${title}\n\n${message}\n\n[OK = ${confirmLabel}]`
  return Promise.resolve(typeof window !== 'undefined' && window.confirm(fullMessage))
}
