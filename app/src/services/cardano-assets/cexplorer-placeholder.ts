/**
 * Telling cexplorer's "no icon" placeholder apart from a real token logo.
 *
 * The icon CDN answers **200 with an image either way**, so a request cannot fail its way to our own
 * placeholder — every asset cexplorer has never seen renders as its generic grey circle. There is no
 * cheap way to ask in advance either: SteelSwap's `hasIcon` describes SteelSwap's own coverage, and
 * cexplorer is used precisely because it has far more icons, so suppressing on that flag would lose
 * the icons cexplorer exists to provide.
 *
 * What is free is the load we are already doing. `expo-image` reports the media type and intrinsic
 * size of what it decoded, so the response can be classified **after** it arrives without a second
 * request, a HEAD, or reading bytes ourselves.
 *
 * ⚠️ **Measured, not guessed** (2026-08-28, against `ix.cexplorer.io/asset/…`):
 *
 * | | content-type | bytes | intrinsic |
 * |---|---|---|---|
 * | a real logo (SNEK, MIN, HOSKY) | `image/webp` | 1.2–5.5 k | 192×192 |
 * | a real logo (WMT) | `image/webp` | 3,782 | 167×167 |
 * | no icon (NMKR) | `image/svg+xml` | 998 | 40×40 |
 *
 * The placeholder is one static file — byte-identical `etag` `"688c92b4-3e6"` for every asset that
 * has no logo, including a policy id that does not exist. Real logos are served at their own size,
 * never 40×40, which is what makes the size test below safe.
 *
 * ⚠️ **On Android the size test is the only branch that fires** (measured on device 2026-08-28, 51
 * loads over the whale's holdings): `expo-image`'s `onLoad` reports `mediaType: null` and the
 * **intrinsic** size — 40×40, not the rendered 36 — so the media-type test is dead there and
 * deleting the size test as a mere fallback would silently restore the grey circles.
 *
 * ⚠️ **Only ever apply this to the cexplorer response.** Our own shipped marks are SVGs too, and
 * classifying one of those as a placeholder would replace it with a placeholder for ever.
 *
 * @module
 */

/** The placeholder's intrinsic size — its `viewBox` is `0 0 40 40`. */
const PLACEHOLDER_EDGE = 40

/**
 * Whether a loaded cexplorer icon is the generic placeholder rather than a real logo.
 *
 * Media type where a platform reports one; the size test carries Android alone, where it never does.
 * Exact match on both edges rather than a bound: 40×40 is one specific file, not a size range, and
 * the CDN's real logos are 167–192 px square.
 */
export const isCexplorerPlaceholder = (loaded: {
  readonly mediaType?: string | null
  readonly width?: number
  readonly height?: number
}): boolean => {
  const mediaType = loaded.mediaType?.toLowerCase().trim()
  if (mediaType !== undefined && mediaType !== null && mediaType.length > 0) {
    return mediaType.startsWith('image/svg')
  }
  return loaded.width === PLACEHOLDER_EDGE && loaded.height === PLACEHOLDER_EDGE
}
