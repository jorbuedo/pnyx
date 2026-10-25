/**
 * Renders the remote-config banner deck for one surface.
 *
 * Copy does not travel in the config JSON: each banner names a `contentId`, and
 * the localized title/body are fetched as markdown from the same bucket
 * (`banners/content/<contentId>/<locale>.md`), cached, and re-read offline. A
 * banner whose copy has not arrived yet renders nothing rather than an empty
 * card.
 *
 * Dismissals persist under `@pnyx/dismissed-banners` and are shared across every
 * mounted instance through a module-level store, so dismissing on one surface
 * does not leave the same banner standing on another.
 *
 * @module
 */

import type {RemoteBanner, RemoteBannerSlot} from '@pnyx/config'
import {useCallback, useEffect, useMemo, useState, useSyncExternalStore} from 'react'

import {useIdentityTracker, useRenderCounter} from '../dev/perf-tracers'
import {logger} from '../logger'
import {storage} from '../platform/storage'
import {useI18n} from '../providers'
import {useRemoteConfig} from '../providers/ConfigProvider'
import {
  fetchRemoteBannerContent,
  loadCachedRemoteBannerContent,
  pruneRemoteBannerContent,
  type RemoteBannerContent,
} from '../services/remote-banner-content'
import {type Banner, BannerCardList} from './BannerCard'
import {bannerSlot, toBannerCard, visibleBanners} from './remote-banner-view'

const ORIGIN = 'RemoteBanners'
const DISMISSED_BANNERS_KEY = '@pnyx/dismissed-banners'
const contentStateKey = (bannerId: string, contentId: string, locale: string): string =>
  `${bannerId}:${contentId}:${locale}`

type RemoteBannersProps = {
  /**
   * The surface this mount represents. Only remote banners whose `slot`
   * field matches (or whose `slot` is absent — defaults to `'home'`)
   * render here. Every call site should pass its own slot identifier so
   * new surfaces can be added without risk of banners leaking across
   * them.
   */
  slot: RemoteBannerSlot
  localBanners?: Banner[] | undefined
  onCloseLocalBanner?: ((banner: Banner) => void) | undefined
}

/**
 * Load dismissed banner IDs from storage.
 */
const loadDismissedBanners = async (): Promise<Set<string>> => {
  try {
    const json = await storage.get(DISMISSED_BANNERS_KEY)
    if (!json) return new Set()
    return new Set(JSON.parse(json) as string[])
  } catch (e) {
    // "nothing was dismissed" and "the read failed" render identically — every
    // dismissed banner comes back standing, which is what this line makes diagnosable.
    logger.warn('dismissed banners could not be read; treating every banner as undismissed', {
      origin: ORIGIN,
      error: String(e),
    })
    return new Set()
  }
}

/**
 * Save dismissed banner IDs to storage.
 */
const saveDismissedBanners = async (ids: ReadonlySet<string>): Promise<void> => {
  try {
    await storage.set(DISMISSED_BANNERS_KEY, JSON.stringify([...ids]))
  } catch (e) {
    // The dismissal already applies in-session; only its persistence is lost, so the
    // banner returns on next launch with nothing else to explain why.
    logger.warn('a banner dismissal could not be persisted; it will return on next launch', {
      origin: ORIGIN,
      error: String(e),
    })
  }
}

// ── Shared dismissed-ids store ────────────────────────────────────────────────
// RemoteBanners is mounted once per dashboard chain page so dismissal needs to
// propagate across every live instance. A module-level snapshot + listener set
// replaces per-mount React state; `useSyncExternalStore` gives each mount a
// consistent view and fires re-renders on change. Hydration runs at most once.

type DismissedSnapshot = {readonly ids: ReadonlySet<string>; readonly hydrated: boolean}

let dismissedSnapshot: DismissedSnapshot = {ids: new Set(), hydrated: false}
const dismissedListeners = new Set<() => void>()
let dismissedHydrating = false

const emitDismissed = () => {
  for (const listener of dismissedListeners) listener()
}

const setDismissedSnapshot = (next: DismissedSnapshot) => {
  dismissedSnapshot = next
  emitDismissed()
}

const subscribeDismissed = (listener: () => void): (() => void) => {
  dismissedListeners.add(listener)
  return () => {
    dismissedListeners.delete(listener)
  }
}

const getDismissedSnapshot = (): DismissedSnapshot => dismissedSnapshot

const ensureDismissedHydrated = async (): Promise<void> => {
  if (dismissedSnapshot.hydrated || dismissedHydrating) return
  dismissedHydrating = true
  try {
    const ids = await loadDismissedBanners()
    setDismissedSnapshot({ids, hydrated: true})
  } finally {
    dismissedHydrating = false
  }
}

const dismissBannerId = (id: string): void => {
  if (dismissedSnapshot.ids.has(id)) return
  const next = new Set(dismissedSnapshot.ids)
  next.add(id)
  setDismissedSnapshot({ids: next, hydrated: dismissedSnapshot.hydrated})
  void saveDismissedBanners(next)
}

// ── Shared content store ──────────────────────────────────────────────────────
// `BaseCarousel` eagerly pre-mounts every chain page so each RemoteBanners
// instance would otherwise fire its own `loadCachedRemoteBannerContent` +
// `fetchRemoteBannerContent` per banner, yielding N×N storage reads and
// network calls. A single shared snapshot dedupes fetches: the first mount
// that sees a `(contentId, locale)` dispatches; all others read the cache.

let contentSnapshot: Readonly<Record<string, RemoteBannerContent>> = {}
const contentListeners = new Set<() => void>()
// Tracks keys with an in-flight (cache + network) fetch. Cleared on settle so
// transient failures retry on the next `ensureContentFetched` call — e.g.
// when a `RemoteBanners` mount remounts after navigation. `contentDispatched`
// earlier marked keys as "attempted" forever, which silently swallowed
// failures for the rest of the session.
const contentInFlight = new Set<string>()
// Keys whose snapshot reflects a fresh network response. Used to stop a
// later-resolving cached read from overwriting fresher data within the
// same fetch cycle. Reset when a retry begins.
const contentFreshApplied = new Set<string>()

const getContentSnapshot = (): Readonly<Record<string, RemoteBannerContent>> => contentSnapshot

const subscribeContent = (listener: () => void): (() => void) => {
  contentListeners.add(listener)
  return () => {
    contentListeners.delete(listener)
  }
}

const setContentEntry = (key: string, content: RemoteBannerContent): void => {
  if (contentSnapshot[key] === content) return
  contentSnapshot = {...contentSnapshot, [key]: content}
  for (const listener of contentListeners) listener()
}

const ensureContentFetched = (bannerId: string, contentId: string, locale: string): void => {
  const key = contentStateKey(bannerId, contentId, locale)
  if (contentSnapshot[key] !== undefined) return
  if (contentInFlight.has(key)) return
  contentInFlight.add(key)
  contentFreshApplied.delete(key)

  const options = {contentId, locale}

  const cache = loadCachedRemoteBannerContent(options)
    .then((content) => {
      if (content && !contentFreshApplied.has(key)) setContentEntry(key, content)
    })
    .catch((e: unknown) => {
      // A miss resolves to null; reaching here means the cache itself is unreadable,
      // which offline leaves the banner rendering nothing with no other trace.
      logger.warn('cached banner copy could not be read', {origin: ORIGIN, key, error: String(e)})
    })

  const fresh = fetchRemoteBannerContent(options)
    .then((content) => {
      if (content) {
        contentFreshApplied.add(key)
        setContentEntry(key, content)
      }
    })
    .catch((e: unknown) => {
      logger.warn('banner copy could not be fetched; falling back to the cache', {
        origin: ORIGIN,
        key,
        error: String(e),
      })
    })

  void Promise.all([cache, fresh]).finally(() => {
    contentInFlight.delete(key)
  })
}

/**
 * Remote banners for `slot`, plus any `localBanners` the caller supplies.
 *
 * Date-range and per-platform filtering already happened in `getBanners`; this
 * component adds slot matching, dismissal, and copy resolution.
 */
export function RemoteBanners({slot, localBanners = [], onCloseLocalBanner}: RemoteBannersProps) {
  useRenderCounter('RemoteBanners')
  const {locale} = useI18n()
  const {banners: allRemoteBanners} = useRemoteConfig()
  const banners = useMemo(
    () => allRemoteBanners.filter((banner) => bannerSlot(banner) === slot),
    [allRemoteBanners, slot],
  )
  const {ids: dismissedIds, hydrated: loaded} = useSyncExternalStore(
    subscribeDismissed,
    getDismissedSnapshot,
    getDismissedSnapshot,
  )
  const bannerContent = useSyncExternalStore(subscribeContent, getContentSnapshot, getContentSnapshot)
  const [dismissedLocalIds, setDismissedLocalIds] = useState<Set<string>>(new Set())

  // Perf instrumentation — finding (F) batches these fetches; first we need to
  // know how many banners come through in real scenarios. Gated on __DEV__ so
  // neither the metadata object nor the `banners.map(...).slice()` allocation
  // happens in prod — `logger.debug` would be level-filtered out, but the
  // argument object is evaluated before the level check.
  useEffect(() => {
    if (!__DEV__) return
    logger.debug('RemoteBanners banners count', {
      origin: 'perf:RemoteBanners',
      count: banners.length,
      ids: banners.map((b) => b.id).slice(0, 20),
    })
  }, [banners])
  useIdentityTracker('RemoteBanners.banners', banners)
  useIdentityTracker('RemoteBanners.bannerContent', bannerContent)

  useEffect(() => {
    void ensureDismissedHydrated()
  }, [])

  const candidateBanners = useMemo(
    () => visibleBanners(allRemoteBanners, slot, dismissedIds),
    [allRemoteBanners, slot, dismissedIds],
  )
  const visibleLocalBanners = useMemo(
    () => localBanners.filter((banner) => !(banner.isDismissible && dismissedLocalIds.has(banner.bannerId))),
    [dismissedLocalIds, localBanners],
  )

  const handleDismiss = useCallback(
    (bannerId: string) => {
      dismissBannerId(bannerId)
      // Once dismissed the banner won't render again, so its cached
      // markdown is dead weight. Prune every locale variant of its
      // contentId so the cache doesn't grow as new banners cycle through
      // over time. Best-effort — the helper swallows storage errors.
      const dismissedBanner = banners.find((banner) => banner.id === bannerId)
      if (dismissedBanner) {
        void pruneRemoteBannerContent(dismissedBanner.contentId)
      }
    },
    [banners],
  )

  const handleCloseCard = useCallback(
    (banner: Banner) => {
      if (candidateBanners.some((remoteBanner) => remoteBanner.id === banner.bannerId)) {
        handleDismiss(banner.bannerId)
        return
      }
      if (banner.isDismissible) {
        setDismissedLocalIds((prev) => {
          const newIds = new Set(prev)
          newIds.add(banner.bannerId)
          return newIds
        })
      }
      onCloseLocalBanner?.(banner)
    },
    [candidateBanners, handleDismiss, onCloseLocalBanner],
  )

  // Stabilize on banner IDs — prevents re-fetching when the banners array
  // gets a new reference from remote config but the actual set hasn't changed.
  const bannersKey = banners.map((b) => b.id).join(',')

  // biome-ignore lint/correctness/useExhaustiveDependencies: bannersKey tracks banner identity; banners read from closure
  useEffect(() => {
    if (!loaded) return
    for (const banner of banners) {
      ensureContentFetched(banner.id, banner.contentId, locale)
    }
    // bannersKey stabilizes on banner IDs instead of the array reference.
    // Remote config updates rebuild the array with new object refs even when
    // the actual banner set hasn't changed, causing 3x re-fetches per URL.
  }, [bannersKey, loaded, locale])

  const remoteBanners = useMemo<Banner[]>(
    () =>
      candidateBanners
        .map((banner) => ({banner, content: bannerContent[contentStateKey(banner.id, banner.contentId, locale)]}))
        .filter((entry): entry is {banner: RemoteBanner; content: RemoteBannerContent} => Boolean(entry.content))
        .map(({banner, content}) => toBannerCard(banner, content)),
    [candidateBanners, bannerContent, locale],
  )

  const allBanners = useMemo<Banner[]>(
    () => [...remoteBanners, ...visibleLocalBanners],
    [remoteBanners, visibleLocalBanners],
  )

  if (!loaded) return null

  // Keep `BannerCardList` mounted while `allBanners` is empty so the
  // height-collapse animation can play after the last banner is dismissed.
  // `BannerCardList` clears its own snapshot when the animation completes
  // (see the `withTiming` callback in its `onClose`), at which point it
  // returns `null` — no lingering zero-height flex item for the ScrollView
  // `gap` to stack around.
  return (
    <BannerCardList
      banners={allBanners}
      locale={locale}
      marginTop={0}
      marginBottom={0}
      onCloseCard={handleCloseCard}
      testID="remote-banners"
    />
  )
}
