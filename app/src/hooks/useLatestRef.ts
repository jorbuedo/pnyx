/**
 * Keeps a ref pointed at the latest value on every render.
 *
 * Replaces the hand-rolled `const xRef = useRef(x); xRef.current = x` mirror
 * pattern. Read `ref.current` inside callbacks/effects to get the current value
 * without adding it to a dependency list (callback stability).
 *
 * @module
 */

import {useRef} from 'react'

export const useLatestRef = <T>(value: T) => {
  const ref = useRef(value)
  ref.current = value
  return ref
}
