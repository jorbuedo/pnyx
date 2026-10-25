/**
 * Handles for every author a surface is about to draw, resolved in one pass.
 *
 * Wraps {@link module:./usePeerHandles} with the author-string rule: a channel author is *either* a
 * disclosed `pnyx_id` or a chosen persona, and only the first can be resolved. Pair it with
 * `authorLabel` from `services/author-label`.
 *
 * @module
 */

import {useMemo} from 'react'
import {disclosedAuthors} from '../services/author-label'
import {usePeerHandles} from './usePeerHandles'

/**
 * `pnyxId → handle` for the disclosed authors among `authors` that hold a name.
 *
 * Safe to call with a freshly-built array every render: the bech32 decode behind
 * {@link disclosedAuthors} is memoised on the authors themselves, not on array identity, so a
 * caller can pass `posts.map((p) => p.author)` inline without a `useMemo` of its own. A display name
 * may contain any character, so the memo key is a JSON round trip rather than a joined string —
 * there is no separator a persona could not also contain.
 */
export const useAuthorHandles = (authors: readonly string[]): ReadonlyMap<string, string> => {
  const key = JSON.stringify(authors)
  const ids = useMemo(() => disclosedAuthors(JSON.parse(key) as readonly string[]), [key])
  return usePeerHandles(ids)
}
