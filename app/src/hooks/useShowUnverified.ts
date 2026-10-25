import {useCallback, useSyncExternalStore} from 'react'
import {getShowUnverifiedSnapshot, setShowUnverified, subscribeShowUnverified} from '../services/portfolio-preference'

/**
 * The persisted unverified-token filter, shared by every surface that renders holdings.
 *
 * `useSyncExternalStore` rather than mount-time state: the tabs are kept alive, so a
 * screen that read the value once would keep filtering by the old rule after the other
 * changed it.
 */
export const useShowUnverified = (): readonly [boolean, (shown: boolean) => void] => {
  const shown = useSyncExternalStore(subscribeShowUnverified, getShowUnverifiedSnapshot)
  const set = useCallback((next: boolean) => {
    void setShowUnverified(next)
  }, [])
  return [shown, set]
}
