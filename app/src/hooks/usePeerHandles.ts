/**
 * Handles for a set of identities, resolved in the background.
 *
 * Returns a map rather than a string so a list resolves once for every row it draws instead of once
 * per row component, and so a peer with no handle is simply absent — the caller falls back to the id.
 *
 * **Seeded synchronously from the memo**, which is what stops the id → name swap on every remount.
 * `peerHandleFor` is a promise even when its answer is already in memory, and a promise cannot settle
 * before the first paint; `knownPeerHandle` can be read *during* render, so a peer seen earlier in the
 * session is drawn with their name immediately. A peer seen for the first time still resolves
 * asynchronously and still swaps once — see `docs/PNYX_IDENTITY_PLAN.md` for why that is the accepted
 * trade rather than persisting names across restarts.
 *
 * @module
 */

import {useEffect, useMemo, useState} from 'react'
import {knownPeerHandle, knownPeerNickname, peerHandleFor, peerNicknameFor} from '../services/peer-label'
import {nameLabel} from '../services/peer-name-label'

const EMPTY: ReadonlyMap<string, string> = new Map()

/** Everything already known for `ids`, for a first paint that needs no lookup. */
const seedFrom = (ids: readonly string[]): ReadonlyMap<string, string> => {
  const seeded = new Map<string, string>()
  for (const id of ids) {
    // The nickname is the name; the handle only decides how it is written. ⚠️ Read in this order and
    // not the other way: a peer whose handle verdict has lapsed still has a current nickname, and
    // seeding nothing for them would draw their id for a frame and then replace it.
    const nickname = knownPeerNickname(id)
    if (typeof nickname !== 'string') continue
    seeded.set(id, nameLabel(nickname, knownPeerHandle(id) === nickname))
  }
  return seeded
}

/**
 * `pnyxId → the label to draw`, for peers whose row names anything.
 *
 * ⚠️ **The value is the label, not the bare name** — `@alice` for a registered handle, `Alice` for a
 * nickname. Composed here rather than at each of the six surfaces that read this map, for the same
 * reason `author-label` exists at all: a per-screen copy is how five of them keep drawing one thing
 * after the sixth starts drawing another. A surface that needs the parts rather than the label should
 * read `peer-label` directly.
 *
 * ⚠️ **A nickname is enough to be in this map.** It used to take a *registered* handle, which is why
 * onboarding needed a permit and a `bind` before anyone could see who you were.
 *
 * Filled in as lookups land: a handle is decoration over an id that is already correct, so blocking a
 * conversation list on a chain read would trade something the user needs for something they merely
 * prefer.
 *
 * Keyed on the joined ids so a changed *set* re-resolves while a re-render with the same peers does
 * not. The effect drops its result if the set changed while it was in flight, which is what stops a
 * slow lookup from painting a name onto the wrong list — and the resolved map is tagged with the key
 * it belongs to, so a stale one is never merged into a new set either.
 *
 * ⚠️ **Without `retryOn`, a failed lookup is never re-tried on this surface.** `peerHandleFor`
 * deliberately does not memoise a read it could not complete, so the chain would answer if asked
 * again — but with the set of ids unchanged this effect does not run again, so nothing asks. A list
 * resolved while the service was unreachable went on drawing ids after the app signed back in, and
 * recovered only indirectly: some *other* surface resolving the same peer into the shared memo, plus a
 * remount to seed from it. Pass whatever marks "the thing that failed may now work" — a session token
 * is the usual one.
 */
export const usePeerHandles = (pnyxIds: readonly string[], retryOn?: string): ReadonlyMap<string, string> => {
  const key = pnyxIds.join(',')
  const [resolved, setResolved] = useState<{readonly key: string; readonly map: ReadonlyMap<string, string>}>({
    key: '',
    map: EMPTY,
  })

  // Recomputed during render, so a new set of peers is drawn from the memo on its *first* paint
  // rather than one paint later.
  const seeded = useMemo(() => seedFrom(key === '' ? [] : key.split(',')), [key])

  // biome-ignore lint/correctness/useExhaustiveDependencies: `retryOn` is a re-run trigger, not a read
  useEffect(() => {
    let live = true
    const ids = key === '' ? [] : key.split(',')
    void Promise.all(
      ids.map(async (id) => {
        // Both from one shared read — `resolvePeer` de-duplicates in flight, so asking for the name
        // and its registration does not cost two lookups.
        const [nickname, handle] = await Promise.all([peerNicknameFor(id), peerHandleFor(id)])
        return [id, nickname === undefined ? undefined : nameLabel(nickname, handle === nickname)] as const
      }),
    ).then((pairs) => {
      if (!live) return
      setResolved({
        key,
        map: new Map(pairs.filter((pair): pair is readonly [string, string] => pair[1] !== undefined)),
      })
    })
    return () => {
      live = false
    }
    // Re-runs the whole set rather than only what failed: a hit costs no network read (the memo
    // answers it), so bookkeeping to tell the two apart would buy nothing.
  }, [key, retryOn])

  return resolved.key === key ? resolved.map : seeded
}
