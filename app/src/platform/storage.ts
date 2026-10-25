/**
 * Platform-specific storage abstraction.
 *
 * Uses MMKV on mobile and chrome.storage on extension.
 * In dev mode, the iframe has no chrome.storage access, so storage
 * operations are proxied through the postMessage bridge to the
 * background service worker.
 *
 * Two views over the same backend:
 *
 * - {@link storage} is **profile-scoped**. Every key is namespaced by the
 *   active profile, so opening the decoy shows the decoy's data and nothing
 *   else. This is the default, and new keys should use it without thinking.
 * - {@link deviceStorage} is **device-global** — the same bytes regardless of
 *   profile. It is a short allowlist: the lock configuration (which has to be
 *   readable before a profile is chosen), the installation id, and the
 *   presentation preferences that would look broken if they flipped between
 *   profiles.
 *
 * The direction of that default is deliberate. A key that should have been
 * global but is scoped merely gets re-set inside the decoy — harmless. A key
 * that should have been scoped but is global leaks the real profile into the
 * decoy, which is the exact failure this partition exists to prevent.
 *
 * The default profile's prefix is empty, so its keys are byte-identical to what
 * installs predating profiles already wrote. No migration.
 *
 * @module
 */

import {activeKeyPrefix} from '../services/profile/active-profile'
import {platformIsWeb} from './detect'
import {isExtensionDevIframe, sendMessage} from './extension/runtime'

// Mobile-only build: extension branches are dead at runtime; @types/chrome removed.
// biome-ignore lint/suspicious/noExplicitAny: dead extension branch — @types/chrome removed with the extension surface
declare const chrome: any

/**
 * Check if running as a browser extension with direct chrome.storage access.
 */
const hasChromeStorage = platformIsWeb && typeof chrome !== 'undefined' && !!chrome?.storage

/** True when {@link storage.getSync} reads MMKV or localStorage (not extension chrome.storage). */
export const storageSupportsSyncGet = !hasChromeStorage && !isExtensionDevIframe

/**
 * MMKV interface matching react-native-mmkv v4.
 */
type MMKVInstance = {
  getString(key: string): string | undefined
  set(key: string, value: string | number | boolean): void
  remove(key: string): void // v4 renamed delete() to remove()
  getAllKeys(): string[]
}

type CreateMMKV = (config?: {id?: string}) => MMKVInstance

/**
 * MMKV instance for React Native.
 * Created lazily to avoid issues on web. Crashes if MMKV is unavailable on mobile.
 */
let mmkv: MMKVInstance | null = null

const getMMKV = (): MMKVInstance => {
  if (mmkv) return mmkv

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const MMKVModule = require('react-native-mmkv') as {createMMKV: CreateMMKV}
  mmkv = MMKVModule.createMMKV({id: 'pnyx-settings'})
  return mmkv
}

/** Maps a caller's key to the key actually written. */
type KeyMap = (key: string) => string

const identityKey: KeyMap = (key) => key

export type PlatformStorage = {
  getSync(key: string): string | null
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
  multiGet(keys: string[]): Promise<Array<[string, string | null]>>
  multiRemove(keys: string[]): Promise<void>
  getAllKeys(): Promise<string[]>
}

/**
 * Build a storage view whose keys are mapped through `enc`.
 *
 * `getAllKeys` reports only the view's own keys, stripped back to the caller's
 * naming — a profile-scoped view must never be able to enumerate a sibling's
 * data, which is the point of the partition.
 */
const makeStorage = (enc: KeyMap, prefixOf: () => string): PlatformStorage => ({
  /**
   * Synchronous get — only works on platforms with sync storage (MMKV, localStorage).
   * Returns null on extension (chrome.storage is async-only).
   * Use this for initial state that must be available before the first render.
   */
  getSync(key: string): string | null {
    if (hasChromeStorage || isExtensionDevIframe) return null

    if (platformIsWeb) {
      try {
        return localStorage.getItem(enc(key))
      } catch (e: unknown) {
        // Blocked site data throws on access. `null` is also "nothing stored", so every caller
        // above this reads a failed storage as an empty one.
        console.warn(`[storage] localStorage read of ${key} failed: ${String(e)}`)
        return null
      }
    }

    return getMMKV().getString(enc(key)) ?? null
  },

  /** Get a value from storage. Rejects on backend failure (chrome.storage `lastError`, localStorage throw). */
  async get(key: string): Promise<string | null> {
    if (isExtensionDevIframe) {
      const res = await sendMessage<{value: string | null}>({type: 'STORAGE_GET', key: enc(key)})
      return res?.value ?? null
    }

    if (hasChromeStorage) {
      return new Promise((resolve, reject) => {
        // biome-ignore lint/suspicious/noExplicitAny: dead extension branch — @types/chrome removed with the extension surface
        chrome.storage.local.get([enc(key)], (result: any) => {
          const err = chrome.runtime.lastError
          if (err) {
            reject(new Error(`chrome.storage.local.get failed: ${err.message ?? 'unknown'}`))
            return
          }
          const value = result[enc(key)]
          resolve(typeof value === 'string' ? value : null)
        })
      })
    }

    if (platformIsWeb) {
      return localStorage.getItem(enc(key))
    }

    return getMMKV().getString(enc(key)) ?? null
  },

  /** Set a value in storage. Rejects on backend failure (chrome.storage `lastError`, localStorage throw). */
  async set(key: string, value: string): Promise<void> {
    if (isExtensionDevIframe) {
      await sendMessage({type: 'STORAGE_SET', key: enc(key), value})
      return
    }

    if (hasChromeStorage) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.set({[enc(key)]: value}, () => {
          const err = chrome.runtime.lastError
          if (err) reject(new Error(`chrome.storage.local.set failed: ${err.message ?? 'unknown'}`))
          else resolve()
        })
      })
    }

    if (platformIsWeb) {
      localStorage.setItem(enc(key), value)
      return
    }

    getMMKV().set(enc(key), value)
  },

  /** Remove a value from storage. Rejects on backend failure (chrome.storage `lastError`, localStorage throw). */
  async remove(key: string): Promise<void> {
    if (isExtensionDevIframe) {
      await sendMessage({type: 'STORAGE_REMOVE', key: enc(key)})
      return
    }

    if (hasChromeStorage) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.remove(enc(key), () => {
          const err = chrome.runtime.lastError
          if (err) reject(new Error(`chrome.storage.local.remove failed: ${err.message ?? 'unknown'}`))
          else resolve()
        })
      })
    }

    if (platformIsWeb) {
      localStorage.removeItem(enc(key))
      return
    }

    getMMKV().remove(enc(key))
  },

  /** Get multiple values at once. Same rejection contract as {@link storage.get}. */
  async multiGet(keys: string[]): Promise<Array<[string, string | null]>> {
    const encoded = keys.map(enc)

    if (isExtensionDevIframe) {
      const res = await sendMessage<{entries: Array<[string, string | null]>}>({
        type: 'STORAGE_MULTI_GET',
        keys: encoded,
      })
      return (
        res?.entries?.map(([, value], i) => [keys[i] as string, value] as [string, string | null]) ??
        keys.map((key) => [key, null] as [string, string | null])
      )
    }

    if (hasChromeStorage) {
      return new Promise((resolve, reject) => {
        // biome-ignore lint/suspicious/noExplicitAny: dead extension branch — @types/chrome removed with the extension surface
        chrome.storage.local.get(encoded, (result: any) => {
          const err = chrome.runtime.lastError
          if (err) {
            reject(new Error(`chrome.storage.local.get (multi) failed: ${err.message ?? 'unknown'}`))
            return
          }
          resolve(keys.map((key) => [key, typeof result[enc(key)] === 'string' ? result[enc(key)] : null]))
        })
      })
    }

    if (platformIsWeb) {
      return keys.map((key) => [key, localStorage.getItem(enc(key))])
    }

    const instance = getMMKV()
    return keys.map((key) => [key, instance.getString(enc(key)) ?? null])
  },

  /** Remove multiple values at once. Same rejection contract as {@link storage.remove}. */
  async multiRemove(keys: string[]): Promise<void> {
    const encoded = keys.map(enc)

    if (isExtensionDevIframe) {
      await sendMessage({type: 'STORAGE_MULTI_REMOVE', keys: encoded})
      return
    }

    if (hasChromeStorage) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.remove(encoded, () => {
          const err = chrome.runtime.lastError
          if (err) reject(new Error(`chrome.storage.local.remove (multi) failed: ${err.message ?? 'unknown'}`))
          else resolve()
        })
      })
    }

    if (platformIsWeb) {
      for (const key of encoded) {
        localStorage.removeItem(key)
      }
      return
    }

    const instance = getMMKV()
    for (const key of encoded) {
      instance.remove(key)
    }
  },

  /** Get all storage keys. Same rejection contract as {@link storage.get}. */
  async getAllKeys(): Promise<string[]> {
    const prefix = prefixOf()
    const own = (all: string[]): string[] =>
      prefix === '' ? all : all.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))

    if (isExtensionDevIframe) {
      const res = await sendMessage<{keys: string[]}>({type: 'STORAGE_GET_ALL_KEYS'})
      return own(res?.keys ?? [])
    }

    if (hasChromeStorage) {
      return new Promise((resolve, reject) => {
        // biome-ignore lint/suspicious/noExplicitAny: dead extension branch — @types/chrome removed with the extension surface
        chrome.storage.local.get(null, (result: any) => {
          const err = chrome.runtime.lastError
          if (err) {
            reject(new Error(`chrome.storage.local.get (all keys) failed: ${err.message ?? 'unknown'}`))
            return
          }
          resolve(own(Object.keys(result)))
        })
      })
    }

    if (platformIsWeb) {
      const keys: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key) keys.push(key)
      }
      return own(keys)
    }

    return own(getMMKV().getAllKeys())
  },
})

/**
 * Profile-scoped storage — the default for everything.
 *
 * The prefix is read per call, not captured at import, so modules that grab a
 * reference at module scope still land in whichever profile the gate opened.
 */
export const storage: PlatformStorage = makeStorage((key) => `${activeKeyPrefix()}${key}`, activeKeyPrefix)

/**
 * Device-global storage — identical across profiles.
 *
 * Allowlist only. Adding a key here means accepting that the decoy sees the
 * real profile's value for it, so the bar is: it must be either non-identifying
 * presentation state, or something the gate needs before a profile exists.
 */
export const deviceStorage: PlatformStorage = makeStorage(identityKey, () => '')
