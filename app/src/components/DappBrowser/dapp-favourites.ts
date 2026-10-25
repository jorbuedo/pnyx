/**
 * The dApps a person starred — the curated ones they kept, and any page they starred themselves.
 *
 * ⚠️ **Favourites are entries, not a set of ids.** Starring only ever meant "lift this curated row"
 * until the browser menu could star the page you are on; an arbitrary URL has no curated entry to
 * point at, so the store has to hold enough to draw a row that was never in the remote list.
 *
 * Pure so it can be tested without the browser screen, which reaches React Native through `Image`
 * and the WebView tab stack.
 *
 * @module
 */

import {logger} from '../../logger'

const ORIGIN = 'dapp-favourites'

/** Profile-scoped: a starred dApp is a preference, not a device fact. */
export const FAVOURITE_DAPPS_KEY = '@pnyx/browser/favourite-dapps'

export type FavouriteDapp = {
  /** Curated entries keep their remote id; a page starred from the browser is keyed by its URL. */
  readonly id: string
  readonly name: string
  readonly url: string
  readonly logo?: string
  /** Empty for a page starred from the browser — only the curated list knows categories. */
  readonly categories: readonly string[]
}

export const isFavourite = (favourites: readonly FavouriteDapp[], id: string): boolean =>
  favourites.some((favourite) => favourite.id === id)

/** Star an unstarred dApp, unstar a starred one. Returns a new list; never mutates. */
export const toggleFavourite = (
  favourites: readonly FavouriteDapp[],
  entry: FavouriteDapp,
): readonly FavouriteDapp[] =>
  isFavourite(favourites, entry.id) ? favourites.filter((f) => f.id !== entry.id) : [...favourites, entry]

/**
 * What starring *this page* should save.
 *
 * ⚠️ **Matches the curated list by URL first**, so starring a dApp from inside the browser and
 * starring its row are the same act. Without that a curated dApp could end up in the list twice —
 * once under its remote id, once under its URL — and unstarring the row would leave the duplicate.
 *
 * Falls back to the page title, then the host: a title is what the page calls itself and can be
 * empty or a placeholder while loading, but a host is always there and always recognisable.
 */
export const favouriteForPage = (
  page: {readonly url: string; readonly title: string},
  curated: readonly FavouriteDapp[],
): FavouriteDapp => {
  const known = curated.find((dapp) => dapp.url === page.url)
  if (known !== undefined) return known
  const title = page.title.trim()
  return {id: page.url, name: title === '' ? hostOf(page.url) : title, url: page.url, categories: []}
}

/** The host, or the raw URL when it will not parse — never an empty label. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host || url
  } catch (error) {
    logger.debug('favourite url would not parse; labelling with the raw string', {origin: ORIGIN, error: String(error)})
    return url
  }
}

/**
 * The list to draw: starred entries first, then the curated ones not already starred.
 *
 * ⚠️ **Both halves keep their own order.** The remote list is curated — its order is somebody's
 * editorial decision — so starring one dApp must not reshuffle the rest, and a comparator on a
 * boolean would be free to. Favourites keep the order they were starred in.
 */
export const listForDisplay = (
  favourites: readonly FavouriteDapp[],
  curated: readonly FavouriteDapp[],
): readonly FavouriteDapp[] => [...favourites, ...curated.filter((dapp) => !isFavourite(favourites, dapp.id))]

/**
 * Read the stored entries.
 *
 * ⚠️ Tolerates anything: stars are decoration on a list that renders fine without them, so a corrupt
 * or half-written value must cost no more than the stars. It never throws — but it does say so,
 * because "nothing starred" and "the store was unreadable" draw the same list.
 */
export const parseFavourites = (stored: string | null): readonly FavouriteDapp[] => {
  if (stored === null || stored === '') return []
  try {
    const parsed: unknown = JSON.parse(stored)
    if (!Array.isArray(parsed)) {
      logger.warn('stored dapp favourites were not a list; starting empty', {origin: ORIGIN})
      return []
    }
    return parsed.filter(isStoredFavourite).map((entry) => ({
      id: entry.id,
      name: entry.name,
      url: entry.url,
      ...(typeof entry.logo === 'string' ? {logo: entry.logo} : {}),
      categories: Array.isArray(entry.categories)
        ? entry.categories.filter((c): c is string => typeof c === 'string')
        : [],
    }))
  } catch (error) {
    logger.warn('stored dapp favourites could not be parsed; starting empty', {origin: ORIGIN, error: String(error)})
    return []
  }
}

/** A stored row is usable only if it can still be drawn *and* opened. */
const isStoredFavourite = (
  value: unknown,
): value is {id: string; name: string; url: string; logo?: unknown; categories?: unknown} => {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string' && typeof entry.name === 'string' && typeof entry.url === 'string'
}

export const serialiseFavourites = (favourites: readonly FavouriteDapp[]): string => JSON.stringify(favourites)
