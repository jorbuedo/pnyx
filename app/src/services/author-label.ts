/**
 * How an author is drawn wherever a circle shows one: their handle when they posted under a
 * disclosed `pnyx_id` and that id's row names one, otherwise the author string itself.
 *
 * Split out of the screens because it is one rule across five surfaces — the channel transcript,
 * its reply references, the long-press sheet, a poll's author line and the membership line. A copy
 * per screen is how four of them keep drawing an id after the fifth stops.
 *
 * The handle only ever comes from {@link module:./peer-label}, i.e. the peer's own row. Nothing
 * here trusts the author string for anything beyond whether it decodes as an id at all.
 *
 * @module
 */

import {authorIdentity, formatAuthor} from './pnyx-forum'

/**
 * The disclosed `pnyx_id`s among `authors`, deduplicated.
 *
 * Pseudonymous authors drop out rather than resolving to nothing: their subject is never sent to
 * clients, so there is no id to look up and asking would be a guaranteed miss per row.
 */
export const disclosedAuthors = (authors: readonly string[]): readonly string[] => {
  const ids = new Set<string>()
  for (const author of authors) {
    const id = authorIdentity(author)
    if (id !== null) ids.add(id)
  }
  return [...ids]
}

/**
 * `author`'s handle, or `undefined` when they posted under a pseudonym, hold no name, or their row
 * has not been read yet.
 *
 * Callers that draw the id alongside the name use this rather than comparing strings with
 * {@link authorLabel} — "a handle replaced the id" is a fact about the lookup, not about the pixels.
 */
export const authorHandle = (author: string, handles: ReadonlyMap<string, string>): string | undefined => {
  const id = authorIdentity(author)
  return id === null ? undefined : handles.get(id)
}

/**
 * What to draw for `author`: the handle when there is one, else the author string within `max`.
 *
 * A handle is never truncated. It is at most 32 bytes, and every surface that draws one clamps to a
 * single line, so the platform ellipsizes an overlong name at the real available width — whereas a
 * middle-truncating `…` would corrupt a name that still had room to fit. `max` therefore only ever
 * bounds the id fallback, which is the case that genuinely never fits.
 */
export const authorLabel = (author: string, handles: ReadonlyMap<string, string>, max?: number): string =>
  authorHandle(author, handles) ?? formatAuthor(author, max)
