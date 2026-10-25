/**
 * Whether an on-device model can serve a request right now (Phase 14 item 38).
 *
 * A hook rather than a plain call because the answer is asynchronous — Android's
 * `checkStatus()` is a suspend function — and because the affordances it gates render
 * before it resolves. Until it does, `availability` is `null`, which callers must
 * treat as "not yet known" and render as *nothing*: flashing a button that then
 * disappears is worse than showing it a beat late.
 *
 * @module
 */

import {getModelStatus, type ModelAvailability} from '@pnyx/model-native'
import {useCallback, useEffect, useState} from 'react'
import {isAiOptedIn} from '../services/ai-preference'

/** `null` while the first read is in flight. `refresh` re-reads after a download. */
export const useModelAvailability = (): {
  readonly availability: ModelAvailability | null
  readonly refresh: () => void
} => {
  const [availability, setAvailability] = useState<ModelAvailability | null>(null)

  useEffect(() => {
    let active = true
    void getModelStatus().then((status) => {
      if (active) setAvailability(status.availability)
    })
    return () => {
      active = false
    }
  }, [])

  const refresh = useCallback(() => {
    void getModelStatus().then((status) => setAvailability(status.availability))
  }, [])

  return {availability, refresh}
}

/**
 * The gate every AI affordance uses: the device can serve a request **and** the user
 * asked for the feature. Capability alone is not consent.
 */
export const useModelReady = (): boolean => {
  const {availability} = useModelAvailability()
  const [optedIn, setOptedIn] = useState<boolean | null>(null)

  useEffect(() => {
    let active = true
    void isAiOptedIn().then((v) => {
      if (active) setOptedIn(v)
    })
    return () => {
      active = false
    }
  }, [])

  return availability === 'available' && optedIn === true
}
