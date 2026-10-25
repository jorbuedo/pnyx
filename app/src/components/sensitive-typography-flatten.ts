/**
 * Pure helper extracted from `SensitiveTypography` so it can be unit-tested
 * without importing the React component (which transitively pulls in
 * Unistyles and other RN-only modules unsuitable for a Node test env).
 *
 * @module
 */

import type {ReactNode} from 'react'

/**
 * Flatten primitive children (string / number / array of those) into a single
 * string so the privacy placeholder can length-match the rendered text. JSX
 * adjacency (`{a}{b}`) hands React an array, so a `typeof === 'string'`
 * check on its own misses the common multi-fragment case (e.g.
 * `{fiatSign}{amount}`) and falls through to the minimum-length placeholder.
 *
 * Returns `undefined` when any non-primitive child is present — the caller
 * should treat that as "no length info" and fall back to the default
 * placeholder length.
 */
export const flattenToString = (children: ReactNode): string | undefined => {
  if (typeof children === 'string') return children
  if (typeof children === 'number') return String(children)
  if (Array.isArray(children)) {
    let acc = ''
    for (const c of children) {
      if (typeof c === 'string') acc += c
      else if (typeof c === 'number') acc += String(c)
      else if (c == null || typeof c === 'boolean') continue
      else return undefined
    }
    return acc
  }
  return undefined
}
