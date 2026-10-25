import * as Updates from 'expo-updates'
import {useEffect, useState} from 'react'
import {Platform} from 'react-native'
import {logger} from '../logger'

declare const __DEV__: boolean

type Phase = 'idle' | 'checking' | 'fetching' | 'reloading' | 'done'

export function useExpoOTAUpdate(): {isUpdating: boolean} {
  const [phase, setPhase] = useState<Phase>('idle')

  useEffect(() => {
    if (Platform.OS === 'web') return
    // ⚠️ `Updates.isEnabled` is true in a dev build, but `checkForUpdateAsync` throws there —
    // "not supported in development builds" — so the guard above is not enough and every launch
    // warned about a check that was never going to run. A dev build loads from Metro; there is no
    // update to find.
    if (__DEV__) return
    if (!Updates.isEnabled) return

    let cancelled = false

    const run = async () => {
      try {
        setPhase('checking')
        const check = await Updates.checkForUpdateAsync()
        if (cancelled) return
        if (!check.isAvailable) {
          setPhase('done')
          return
        }

        setPhase('fetching')
        const fetched = await Updates.fetchUpdateAsync()
        if (cancelled) return
        if (!fetched.isNew) {
          setPhase('done')
          return
        }

        setPhase('reloading')
        await Updates.reloadAsync()
      } catch (error) {
        logger.warn('Expo OTA update failed', {origin: 'useExpoOTAUpdate', error})
        if (!cancelled) setPhase('done')
      }
    }

    run()
    return () => {
      cancelled = true
    }
  }, [])

  return {isUpdating: phase === 'fetching' || phase === 'reloading'}
}
