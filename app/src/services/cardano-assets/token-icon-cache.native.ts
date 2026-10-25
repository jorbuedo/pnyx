/**
 * Token-icon resolution — native. SteelSwap serves icons at an inconsistent
 * 1000–1200px (7–55 KB) with no server-side size param, but the largest slot we
 * render is 40pt (≈120 px @3x). So on first sight we download the source once,
 * downscale it to {@link MAX_EDGE_PX}, and cache the small PNG under the
 * expo-file-system cache dir keyed by unit; every later render is a local
 * `file://` read. Failures (404 for an unlisted token, a non-image body, a
 * decode error) resolve to `null` → the caller shows an initials fallback.
 *
 * Mirrors the download+cache shape of `pnyx-artifacts.ts`.
 *
 * @module
 */

import {Directory, File, Paths} from 'expo-file-system'
import {ImageManipulator, SaveFormat} from 'expo-image-manipulator'
import {logger} from '../../logger'

const ICON_DIR = 'cardano-token-icons'
/** Longest edge we ever render a token icon at is 40pt; cache at 40pt @3x. */
const MAX_EDGE_PX = 128

const iconDir = (): Directory => {
  const dir = new Directory(Paths.cache, ICON_DIR)
  if (!dir.exists) dir.create({intermediates: true})
  return dir
}

export const resolveTokenIconUri = async (unit: string, iconUrl: string): Promise<string | null> => {
  if (unit.length === 0) return null
  const dir = iconDir()
  const cached = new File(dir, `${unit}.png`)
  if (cached.exists) return cached.uri

  const src = new File(dir, `${unit}.src`)
  try {
    if (src.exists) src.delete()
    await File.downloadFileAsync(iconUrl, src)
    const context = ImageManipulator.manipulate(src.uri)
    context.resize({width: MAX_EDGE_PX})
    const image = await context.renderAsync()
    const saved = await image.saveAsync({format: SaveFormat.PNG})
    new File(saved.uri).move(cached)
    return cached.uri
  } catch (e: unknown) {
    // A concurrent resolve may have populated the cache between our check and here — which is
    // why the fallback re-checks rather than failing. A render that genuinely failed takes the
    // same branch and leaves the token iconless.
    logger.debug('Token icon could not be rendered; falling back to the cache', {
      origin: 'token-icon-cache',
      error: String(e),
    })
    return cached.exists ? cached.uri : null
  } finally {
    if (src.exists) src.delete()
  }
}
