/**
 * The starred-dApp list, loaded once and shared by the surfaces that read or change it.
 *
 * ⚠️ **One owner, because two surfaces touch the same list.** The start page stars a curated row and
 * the browser menu stars the page you are on; if each kept its own copy, starring in one would leave
 * the other showing the opposite until it remounted. The screen holds this hook and passes what each
 * needs down.
 *
 * @module
 */

import {useCallback, useEffect, useState} from 'react'

import {logger} from '../../logger'
import {storage} from '../../platform/storage'
import {
  FAVOURITE_DAPPS_KEY,
  type FavouriteDapp,
  parseFavourites,
  serialiseFavourites,
  toggleFavourite,
} from './dapp-favourites'

const ORIGIN = 'useDappFavourites'

export type DappFavourites = {
  readonly favourites: readonly FavouriteDapp[]
  readonly toggle: (entry: FavouriteDapp) => void
}

export const useDappFavourites = (): DappFavourites => {
  const [favourites, setFavourites] = useState<readonly FavouriteDapp[]>([])

  useEffect(() => {
    let live = true
    void storage
      .get(FAVOURITE_DAPPS_KEY)
      .then((stored) => {
        if (live) setFavourites(parseFavourites(stored))
      })
      .catch((error: unknown) => {
        // The list still renders; only the stars are lost. Saying so is what tells a missing star
        // apart from a read that never came back.
        logger.warn('favourite dapps could not be read', {origin: ORIGIN, error: String(error)})
      })
    return () => {
      live = false
    }
  }, [])

  const toggle = useCallback((entry: FavouriteDapp) => {
    setFavourites((current) => {
      const next = toggleFavourite(current, entry)
      void storage.set(FAVOURITE_DAPPS_KEY, serialiseFavourites(next)).catch((error: unknown) => {
        logger.warn('favourite dapps could not be saved', {origin: ORIGIN, error: String(error)})
      })
      return next
    })
  }, [])

  return {favourites, toggle}
}
