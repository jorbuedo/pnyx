/**
 * Dev-only floating button that dumps all storage keys and values to the console.
 *
 * Dumps both:
 * 1. Key-value storage (MMKV / localStorage / chrome.storage)
 * 2. Binary store (IndexedDB / SQLite) — wallet data, transactions, snapshots
 *
 * Only rendered when __DEV__ is true (guarded at the call site in _layout).
 *
 * @module
 */

import {useCallback} from 'react'
import {Pressable} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {logger} from '../logger'
import {storage} from '../platform/storage'
import {Typography} from './Typography'

const NETWORKS = ['mainnet', 'testnet', 'preprod', 'preview'] as const
const IDB_STORE_NAME = 'keyvalue'

async function dumpKeyValueStorage() {
  const allKeys = await storage.getAllKeys()

  if (allKeys.length === 0) {
    logger.info('KV storage is empty', {origin: 'DevDbDump'})
    console.log('[DevDbDump] KV storage is empty')
    return
  }

  const entries = await storage.multiGet(allKeys)

  logger.info(`KV storage: ${entries.length} keys`, {origin: 'DevDbDump'})
  console.group(`[DevDbDump] KV storage: ${entries.length} keys`)

  for (const [key, value] of entries) {
    let parsed: unknown = value
    if (value != null) {
      try {
        parsed = JSON.parse(value)
      } catch (e: unknown) {
        // Not JSON — keep as string. The throw is the probe's answer.
        logger.debug('Stored value is not JSON; dumping it as a string', {
          origin: 'DevDbDumpButton',
          error: String(e),
        })
      }
    }

    logger.info(`KV[${key}]`, {origin: 'DevDbDump', key, value: parsed})
    console.log(`  ${key}:`, parsed)
  }

  console.groupEnd()
}

function hexToString(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return new TextDecoder().decode(bytes)
}

async function dumpIndexedDB(dbName: string): Promise<number> {
  if (typeof indexedDB === 'undefined') return 0

  return new Promise((resolve) => {
    const request = indexedDB.open(dbName, 1)

    request.onerror = () => {
      resolve(0)
    }

    request.onsuccess = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
        db.close()
        resolve(0)
        return
      }

      const tx = db.transaction(IDB_STORE_NAME, 'readonly')
      const store = tx.objectStore(IDB_STORE_NAME)
      const cursorReq = store.openCursor()
      let count = 0

      console.group(`[DevDbDump] IndexedDB "${dbName}"`)

      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (cursor) {
          count++
          const hexKey = cursor.key as string
          const key = hexToString(hexKey)
          const valueBytes = new Uint8Array(cursor.value as ArrayBuffer)
          let value: unknown
          try {
            value = JSON.parse(new TextDecoder().decode(valueBytes))
          } catch (e: unknown) {
            // Binary rows are ordinary here, so the byte-count placeholder is the right dump —
            // the line below still names the row, so nothing is lost silently.
            logger.debug('IDB value is not JSON; dumping its size', {
              origin: 'DevDbDump',
              key,
              error: String(e),
            })
            value = `<${valueBytes.length} bytes>`
          }

          logger.info(`IDB[${key}]`, {origin: 'DevDbDump', db: dbName, key, value})
          console.log(`  ${key}:`, value)

          cursor.continue()
        } else {
          console.groupEnd()
          logger.info(`IndexedDB "${dbName}": ${count} entries`, {origin: 'DevDbDump'})
          db.close()
          resolve(count)
        }
      }

      cursorReq.onerror = () => {
        console.groupEnd()
        db.close()
        resolve(count)
      }
    }

    request.onupgradeneeded = () => {
      // DB didn't exist — close and clean up
      request.result.close()
      indexedDB.deleteDatabase(dbName)
      resolve(0)
    }
  })
}

async function dumpBinaryStores() {
  if (typeof indexedDB === 'undefined') {
    logger.info('IndexedDB not available on this platform', {origin: 'DevDbDump'})
    return
  }

  let totalEntries = 0
  for (const network of NETWORKS) {
    totalEntries += await dumpIndexedDB(`pnyx-wallet-${network}`)
  }

  if (totalEntries === 0) {
    logger.info('All binary stores are empty', {origin: 'DevDbDump'})
    console.log('[DevDbDump] All binary stores (IndexedDB) are empty')
  }
}

async function dumpAll() {
  console.group('[DevDbDump] === Full DB Dump ===')
  await dumpKeyValueStorage()
  await dumpBinaryStores()
  console.groupEnd()
}

export function DevDbDumpButton() {
  const handlePress = useCallback(() => {
    dumpAll()
  }, [])

  return (
    <Pressable style={styles.fab} onPress={handlePress} testID="dev-db-dump-fab">
      <Typography variant="bodyXs_medium" style={styles.fabText}>
        DB
      </Typography>
    </Pressable>
  )
}

const styles = StyleSheet.create(() => ({
  fab: {
    position: 'absolute',
    bottom: 212,
    right: 16,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#065F46',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  },
  fabText: {
    color: '#FFFFFF',
    fontSize: 10,
  },
}))
