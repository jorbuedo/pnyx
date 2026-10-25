/**
 * Shared derivation path utilities.
 *
 * This file contains shared utilities that are used by all chain-specific
 * derivation modules. It exists to avoid circular dependencies.
 *
 * @module
 */

/**
 * Hardened derivation constant.
 */
export const HARDENED = 0x80000000

/**
 * Parses a derivation path string to an array of numbers.
 *
 * Throws on anything that is not a run of `/`-separated indices, each optionally hardened with
 * `'` or `h`. The array is handed to a hardware device verbatim, so a component that is not an
 * index has no safe reading: `parseInt` used to make `"zz"` and `""` into `NaN`, and -- the one
 * that matters -- `"1e3"` into `1`, so a typo became a VALID path deriving a DIFFERENT key.
 *
 * @param path - Path string (e.g., "m/44'/60'/0'/0/0")
 * @returns Array of path components with hardening applied
 * @throws Error when the path is empty or any component is not an index
 */
export const parseDerivationPath = (path: string): readonly number[] => {
  const body = path.replace(/^m\//, '')
  if (body === '') throw new Error(`derivation path: "${path}" names no indices`)
  return body.split('/').map((component) => {
    const hardened = component.endsWith("'") || component.endsWith('h')
    const digits = hardened ? component.slice(0, -1) : component
    if (!/^\d+$/.test(digits)) {
      throw new Error(`derivation path: "${component}" is not an index in "${path}"`)
    }
    const index = Number.parseInt(digits, 10)
    if (!Number.isSafeInteger(index) || index >= HARDENED) {
      throw new Error(`derivation path: index ${digits} is out of range in "${path}"`)
    }
    return hardened ? index + HARDENED : index
  })
}

/**
 * Parses a path that a caller was required to supply.
 *
 * Exists because the device adapters used to write `parseDerivationPath(params.stakingPath ?? '')`
 * -- turning "the caller omitted this" into a path of one `NaN` component and sending it to the
 * device. Naming the missing field is the only useful thing to do with that.
 *
 * @throws Error naming the field when the path is absent
 */
export const requireDerivationPath = (path: string | undefined, field: string): readonly number[] => {
  if (path === undefined || path === '') throw new Error(`${field} is required and was not supplied`)
  return parseDerivationPath(path)
}

/**
 * Formats a path array back to a string.
 *
 * @param path - Array of path components
 * @returns Path string
 */
export const formatDerivationPath = (path: readonly number[]): string => {
  const components = path.map((component) => {
    const isHardened = component >= HARDENED
    const index = isHardened ? component - HARDENED : component
    return isHardened ? `${index}'` : String(index)
  })
  return `m/${components.join('/')}`
}

/**
 * Checks if a path component is hardened.
 *
 * @param component - Path component
 * @returns True if hardened
 */
export const isHardened = (component: number): boolean => component >= HARDENED

/**
 * Makes a path component hardened.
 *
 * @param index - Index value
 * @returns Hardened index
 */
export const harden = (index: number): number => index + HARDENED

/**
 * Removes hardening from a path component.
 *
 * @param component - Path component
 * @returns Unhardened index
 */
export const unharden = (component: number): number => (component >= HARDENED ? component - HARDENED : component)
