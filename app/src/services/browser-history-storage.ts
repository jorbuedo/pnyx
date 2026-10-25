/**
 * Persistent browsing-history storage for the in-app dApp browser.
 *
 * Replaces the history slice of the retired @pnyx/dapp-connector
 * `ConnectorStorage` — sessions/approvals are gone with the connector.
 *
 * @module
 */

import {logger} from '../logger'
import {storage} from '../platform/storage'

// Storage key kept from the previous connector storage so existing installs
// retain their browsing history.
const DAPP_HISTORY_KEY = '@pnyx/dapp/history'

// Maximum history entries to retain
const MAX_HISTORY_ENTRIES = 100

/** One visited-URL entry. */
export type BrowserHistoryEntry = {
  readonly url: string
  readonly title?: string
  readonly visitedAt: number
}

export type BrowserHistoryStorage = {
  readonly getHistory: () => Promise<readonly BrowserHistoryEntry[]>
  readonly addHistory: (entry: BrowserHistoryEntry) => Promise<void>
  readonly clearHistory: () => Promise<void>
}

/**
 * Serialized history entry format for storage.
 * Converts visitedAt timestamp to ISO string for JSON serialization
 * (matches the format the previous connector storage wrote).
 */
type SerializedHistoryEntry = Omit<BrowserHistoryEntry, 'visitedAt'> & {
  readonly visitedAt: string
}

export const createBrowserHistoryStorage = (): BrowserHistoryStorage => {
  const load = async (): Promise<readonly BrowserHistoryEntry[]> => {
    try {
      const json = await storage.get(DAPP_HISTORY_KEY)
      if (!json) return []
      const parsed = JSON.parse(json) as readonly SerializedHistoryEntry[]
      return parsed.map((e) => ({
        url: e.url,
        ...(e.title !== undefined ? {title: e.title} : {}),
        visitedAt: new Date(e.visitedAt).getTime(),
      }))
    } catch (e) {
      logger.warn('Failed to load browser history', {origin: 'BrowserHistoryStorage', error: String(e)})
      return []
    }
  }

  const save = async (entries: readonly BrowserHistoryEntry[]): Promise<void> => {
    const serialized: readonly SerializedHistoryEntry[] = entries.map((e) => ({
      url: e.url,
      ...(e.title !== undefined ? {title: e.title} : {}),
      visitedAt: new Date(e.visitedAt).toISOString(),
    }))
    await storage.set(DAPP_HISTORY_KEY, JSON.stringify(serialized))
  }

  return {
    getHistory: load,
    addHistory: async (entry) => {
      try {
        const history = await load()
        const next = [entry, ...history.filter((e) => e.url !== entry.url)].slice(0, MAX_HISTORY_ENTRIES)
        await save(next)
      } catch (e) {
        logger.warn('Failed to add browser history entry', {origin: 'BrowserHistoryStorage', error: String(e)})
      }
    },
    clearHistory: async () => {
      try {
        await storage.remove(DAPP_HISTORY_KEY)
      } catch (e) {
        logger.warn('Failed to clear browser history', {origin: 'BrowserHistoryStorage', error: String(e)})
      }
    },
  }
}
