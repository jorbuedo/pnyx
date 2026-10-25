/**
 * Key-prefix decorator for any {@link Storage}.
 *
 * Wraps an existing storage so every key is transparently namespaced. Used to
 * partition one physical store between profiles: the caller keeps writing
 * `@pnyx/wallet/groups` and the bytes land under `<prefix>@pnyx/wallet/groups`.
 *
 * An empty prefix returns the inner storage untouched, which is what keeps the
 * default profile byte-compatible with installs that predate profiles — no
 * migration, no re-key.
 *
 * @module
 */

import {Effect} from 'effect'
import type {Storage} from './types.js'

/**
 * Namespace `inner` under `prefix`.
 *
 * `keys()` lists only this namespace's keys, stripped back to their unprefixed
 * form, and `clear()` removes only this namespace — a prefixed view must never
 * be able to see or destroy a sibling's data, which is the whole point of the
 * partition.
 *
 * @param inner - The storage to wrap
 * @param prefix - Namespace prefix; `''` returns `inner` unchanged
 */
export const createPrefixedStorage = (inner: Storage, prefix: string): Storage => {
  if (prefix === '') return inner

  const enc = (key: string): string => `${prefix}${key}`
  const dec = (key: string): string => key.slice(prefix.length)
  const mine = (key: string): boolean => key.startsWith(prefix)

  return {
    get: (key) => inner.get(enc(key)),

    set: (key, value) => inner.set(enc(key), value),

    remove: (key) => inner.remove(enc(key)),

    clear: () =>
      Effect.gen(function* () {
        const all = yield* inner.keys()
        const ours = all.filter(mine)
        if (ours.length > 0) yield* inner.multiRemove(ours)
      }),

    keys: () =>
      Effect.gen(function* () {
        const all = yield* inner.keys()
        return all.filter(mine).map(dec)
      }),

    multiGet: (keys) =>
      Effect.gen(function* () {
        const pairs = yield* inner.multiGet(keys.map(enc))
        return pairs.map(([key, value]) => [dec(key), value] as [string, string | null])
      }),

    multiSet: (entries) => inner.multiSet(entries.map(([key, value]) => [enc(key), value] as [string, string])),

    multiRemove: (keys) => inner.multiRemove(keys.map(enc)),
  }
}
