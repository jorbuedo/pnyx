import {useCallback, useEffect, useState} from 'react'

import {storage} from '../platform/storage'

const STORAGE_KEY = '@pnyx/auto_lock_timer'

export const AUTO_LOCK_VALUES = ['immediately', '1m', '5m', '15m', '30m'] as const
export type AutoLockValue = (typeof AUTO_LOCK_VALUES)[number]

const DEFAULT_VALUE: AutoLockValue = '5m'

const AUTO_LOCK_MS: Record<AutoLockValue, number> = {
  immediately: 0,
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
}

// Module-level pub/sub so all hook instances share the same value
const listeners = new Set<(value: AutoLockValue) => void>()
function notify(value: AutoLockValue) {
  for (const listener of listeners) listener(value)
}

export function useAutoLockTimer() {
  const [value, setValue] = useState<AutoLockValue>(DEFAULT_VALUE)
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    storage.get(STORAGE_KEY).then((stored) => {
      if (stored && AUTO_LOCK_VALUES.includes(stored as AutoLockValue)) {
        setValue(stored as AutoLockValue)
      }
      setIsReady(true)
    })
  }, [])

  useEffect(() => {
    listeners.add(setValue)
    return () => {
      listeners.delete(setValue)
    }
  }, [])

  const setAutoLock = useCallback(async (newValue: AutoLockValue) => {
    setValue(newValue)
    notify(newValue)
    await storage.set(STORAGE_KEY, newValue)
  }, [])

  return {value, timeoutMs: AUTO_LOCK_MS[value], setAutoLock, isReady}
}
