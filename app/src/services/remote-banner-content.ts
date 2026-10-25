import {getRemoteConfigAssetUrl} from '@pnyx/config'
import {logger} from '../logger'
import {storage} from '../platform/storage'

const REMOTE_BANNER_CONTENT_CACHE_PREFIX = '@pnyx/remote-banner-content'
const DEFAULT_LOCALE = 'en-US'

export type RemoteBannerContent = {
  readonly title: string
  readonly message: string
  readonly actionLabel?: string
}

export type RemoteBannerContentOptions = {
  readonly contentId: string
  readonly locale: string
}

type FetchText = (url: string) => Promise<string | null>

export const getRemoteBannerContentCacheKey = (contentId: string, locale: string): string =>
  `${REMOTE_BANNER_CONTENT_CACHE_PREFIX}/${contentId}/${locale}`

const getRemoteBannerContentPath = (contentId: string, locale: string): string =>
  `banners/content/${encodeURIComponent(contentId)}/${encodeURIComponent(locale)}.md`

export const parseRemoteBannerMarkdown = (markdown: string): RemoteBannerContent | null => {
  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const titleLine = lines.find((line) => line.startsWith('# '))
  const title = titleLine?.slice(2).trim()
  if (!title) return null

  const ctaLine = lines.find((line) => line.startsWith('[cta]:'))
  const actionLabel = ctaLine?.slice('[cta]:'.length).trim() || undefined
  const message = lines
    .filter((line) => line !== titleLine && line !== ctaLine)
    .join(' ')
    .trim()

  if (!message) return null

  return actionLabel ? {title, message, actionLabel} : {title, message}
}

const defaultFetchText: FetchText = async (url) => {
  const response = await fetch(url)
  if (!response.ok) return null
  return response.text()
}

const fetchMarkdown = async (
  options: RemoteBannerContentOptions,
  fetchText: FetchText = defaultFetchText,
): Promise<string | null> => {
  const locales = options.locale === DEFAULT_LOCALE ? [DEFAULT_LOCALE] : [options.locale, DEFAULT_LOCALE]

  for (const locale of locales) {
    const path = getRemoteBannerContentPath(options.contentId, locale)
    const text = await fetchText(getRemoteConfigAssetUrl(path))
    if (text) return text
  }

  return null
}

export const loadCachedRemoteBannerContent = async (
  options: RemoteBannerContentOptions,
): Promise<RemoteBannerContent | null> => {
  try {
    const cached = await storage.get(getRemoteBannerContentCacheKey(options.contentId, options.locale))
    return cached ? parseRemoteBannerMarkdown(cached) : null
  } catch (error) {
    logger.warn('Failed to load cached remote banner content', {origin: 'RemoteBannerContent', error})
    return null
  }
}

// Fetch dedup + short-lived result cache. Two layers:
// 1. In-flight: concurrent calls share the same promise (dedup)
// 2. Settled: keep the resolved promise for 60s so subsequent effect
//    re-fires (from bannersKey identity changes) return cached content
//    instead of re-fetching. Banner content is static — 60s is safe.
const fetchCache = new Map<string, Promise<RemoteBannerContent | null>>()
const FETCH_RESULT_TTL = 60_000

/** @internal Test-only: clear the fetch cache between tests. */
export const _resetInFlightFetches = (): void => {
  fetchCache.clear()
}

export const fetchRemoteBannerContent = async (
  options: RemoteBannerContentOptions,
  fetchText?: FetchText,
): Promise<RemoteBannerContent | null> => {
  // Safe: contentId is a slug (e.g. "dev-remote-target"), locale is BCP-47 (e.g. "en-US") — no colons
  const dedupKey = `${options.contentId}:${options.locale}`
  const existing = fetchCache.get(dedupKey)
  if (existing) return existing

  const promise = (async (): Promise<RemoteBannerContent | null> => {
    try {
      const markdown = await fetchMarkdown(options, fetchText)
      if (!markdown) return null

      const content = parseRemoteBannerMarkdown(markdown)
      if (!content) return null

      storage.set(getRemoteBannerContentCacheKey(options.contentId, options.locale), markdown).catch((error) => {
        logger.warn('Failed to cache remote banner content', {origin: 'RemoteBannerContent', error})
      })

      return content
    } catch (error) {
      logger.warn('Failed to fetch remote banner content', {origin: 'RemoteBannerContent', error})
      // Evict failed entries immediately so next call retries
      fetchCache.delete(dedupKey)
      return null
    }
  })()

  fetchCache.set(dedupKey, promise)
  // Evict after TTL — only if the entry is still this promise (a failed
  // retry may have replaced it with a fresh promise in the meantime).
  setTimeout(() => {
    if (fetchCache.get(dedupKey) === promise) fetchCache.delete(dedupKey)
  }, FETCH_RESULT_TTL)
  return promise
}

/**
 * Remove every cached markdown entry for a given `contentId` across all
 * locales. Used when a banner is dismissed — the cached copy is dead
 * weight (banner won't render again), and without cleanup storage grows
 * every time a new banner cycles through.
 *
 * Best-effort: enumeration or remove failures are logged and swallowed.
 */
export const pruneRemoteBannerContent = async (contentId: string): Promise<void> => {
  try {
    const prefix = `${REMOTE_BANNER_CONTENT_CACHE_PREFIX}/${contentId}/`
    const allKeys = await storage.getAllKeys()
    const toRemove = allKeys.filter((key) => key.startsWith(prefix))
    if (toRemove.length === 0) return
    await Promise.all(
      toRemove.map((key) =>
        storage.remove(key).catch((error) => {
          logger.warn('Failed to remove cached remote banner content', {origin: 'RemoteBannerContent', key, error})
        }),
      ),
    )
  } catch (error) {
    logger.warn('Failed to prune remote banner content cache', {origin: 'RemoteBannerContent', contentId, error})
  }
}
