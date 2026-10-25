/**
 * Token-icon resolution — web/default. SteelSwap's `/tokens/icon/{unit}/` is a
 * CDN URL served as an `<img>`-loadable PNG, which the browser + `expo-image`
 * memory-disk cache handle directly (image loads aren't CORS-gated), so there's
 * nothing to downscale or file-cache on web — return the URL as-is. Native
 * overrides this with an on-device resize + file cache (`.native.ts`), where
 * the raw 1000–1200px source would otherwise sit full-resolution on disk.
 *
 * @module
 */

/** Resolve a renderable icon URI for `unit`, given its full-resolution `iconUrl`. */
export const resolveTokenIconUri = async (unit: string, iconUrl: string): Promise<string | null> =>
  unit.length === 0 ? null : iconUrl
