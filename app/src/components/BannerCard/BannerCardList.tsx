/**
 * BannerCardList component.
 *
 * @module
 */

import {useEffect, useMemo, useRef, useState} from 'react'
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'

import {useRenderCounter} from '../../dev/perf-tracers'
import {type Banner, BannerCard, CARD_HEIGHT} from './BannerCard'

const DISMISS_DURATION = 300

export type BannerCardListProps = {
  banners: Banner[]
  locale?: string | undefined
  marginTop?: number | undefined
  marginBottom?: number | undefined
  onCloseCard?: ((banner: Banner) => void) | undefined
  testID?: string | undefined
}

const sortBanners = (banners: Banner[]): Banner[] =>
  [...banners].sort((a, b) => b.priorityWeight - a.priorityWeight || a.bannerId.localeCompare(b.bannerId))

/**
 * Stringify a field that may be a MultiLangText record or a plain string.
 * Identity-check purposes only; the exact key ordering of
 * Object.entries is stable for string keys under ECMA-262.
 */
const fingerprintText = (v: string | Record<string, string> | undefined): string => {
  if (v == null) return ''
  if (typeof v === 'string') return v
  const parts: string[] = []
  for (const k of Object.keys(v)) {
    parts.push(k, v[k] ?? '')
  }
  return parts.join('\u0002')
}

/**
 * Fingerprint of every per-banner field the user can see — used to
 * detect real content changes vs. a prop-identity-only change. Joins
 * with U+0001 (a byte that can't appear in the underlying string
 * fields) so unrelated fields can never collide. Faster than
 * JSON.stringify + `.map` allocations, and this function is called
 * multiple times per render in the hot effect below.
 */
const bannerSnapshotKey = (banners: Banner[]): string => {
  const parts: string[] = [String(banners.length)]
  for (const b of banners) {
    parts.push(
      b.bannerId,
      fingerprintText(b.title),
      fingerprintText(b.description),
      fingerprintText(b.actionLabel),
      typeof b.imageUrl === 'string' ? b.imageUrl : '',
      b.isDismissible ? '1' : '0',
      String(b.priorityWeight),
      b.testID ?? '',
      b.dismissTestID ?? '',
      b.type ?? '',
      b.destination ?? '',
    )
  }
  return parts.join('\u0001')
}

const bannerIdKey = (banners: Banner[]): string => banners.map((banner) => banner.bannerId).join('\u0001')

/**
 * Renders banners as an absolutely-stacked vertical deck. Dismissing a card
 * slides it out and reveals the one beneath. When the last card is dismissed
 * the container animates its height to zero and removes itself from layout.
 *
 * Banners are rendered in descending `priorityWeight` order (highest on top).
 *
 * @example
 * ```tsx
 * <BannerCardList
 *   banners={fetchedBanners}
 *   locale="en"
 *   onCloseCard={(banner) => markDismissed(banner.bannerId)}
 * />
 * ```
 */
export const BannerCardList = ({
  banners,
  locale,
  marginTop = 16,
  marginBottom = 16,
  onCloseCard,
  testID,
}: BannerCardListProps) => {
  useRenderCounter('BannerCardList')
  const [snapshot, setSnapshot] = useState(() => sortBanners(banners))
  const totalCards = snapshot.length
  const activeIndex = useSharedValue(0)
  const dismissCountRef = useRef(0)
  const dismissedIdsRef = useRef(new Set<string>())
  // Track the current snapshot's fingerprints via a ref so the effect can
  // compare without listing `snapshot` in its deps (which used to make the
  // effect re-run immediately after setSnapshot, re-fingerprint everything,
  // and then bail — burning work in a self-triggered loop).
  const snapshotRef = useRef(snapshot)
  const snapshotKeysRef = useRef({
    id: bannerIdKey(snapshot),
    content: bannerSnapshotKey(snapshot),
  })

  // Derived fingerprint of the incoming banners. useMemo means we pay the
  // string-build cost once per `banners` identity change, not 3× per
  // render like the previous inline call sites.
  const nextKeys = useMemo(() => {
    const next = sortBanners(banners)
    return {
      next,
      id: bannerIdKey(next),
      content: bannerSnapshotKey(next),
    }
  }, [banners])

  useEffect(() => {
    const {next, id: nextIdKey, content: nextContentKey} = nextKeys
    const currentIdKey = snapshotKeysRef.current.id
    const currentContentKey = snapshotKeysRef.current.content

    // Dismissal-only update: the ids / content of the non-dismissed banners
    // already match. Skip the re-snapshot so an in-flight dismissal
    // animation isn't interrupted.
    if (dismissedIdsRef.current.size > 0) {
      const activeSnapshot = snapshotRef.current.filter((b) => !dismissedIdsRef.current.has(b.bannerId))
      if (bannerIdKey(activeSnapshot) === nextIdKey && bannerSnapshotKey(activeSnapshot) === nextContentKey) {
        return
      }
    }

    // No real content change — skip.
    if (nextIdKey === currentIdKey && nextContentKey === currentContentKey) return

    dismissedIdsRef.current.clear()
    dismissCountRef.current = 0
    activeIndex.value = 0
    snapshotRef.current = next
    snapshotKeysRef.current = {id: nextIdKey, content: nextContentKey}
    setSnapshot(next)
  }, [activeIndex, nextKeys])

  // Seed the shared values with the resting (visible) state so the initial
  // mount doesn't animate height 0 → CARD_HEIGHT on every Home re-render
  // (the banner cards lived under a parent that can re-mount on tab return
  // before this was fixed). Only the *transition* to `allDismissed` runs
  // through `withTiming` — mount paints the final size.
  const heightSV = useSharedValue<number>(CARD_HEIGHT)
  const marginTopSV = useSharedValue<number>(marginTop)
  const marginBottomSV = useSharedValue<number>(marginBottom)

  useAnimatedReaction(
    () => activeIndex.value >= totalCards,
    (allDismissed, prev) => {
      // Skip the first evaluation — it re-asserts the seeded value and
      // would have been a no-op anyway.
      if (prev === null) return
      const duration = DISMISS_DURATION
      heightSV.value = withTiming(allDismissed ? 0 : CARD_HEIGHT, {duration})
      marginTopSV.value = withTiming(allDismissed ? 0 : marginTop, {duration})
      marginBottomSV.value = withTiming(allDismissed ? 0 : marginBottom, {duration})
    },
    [totalCards, marginTop, marginBottom],
  )

  const stylez = useAnimatedStyle(() => ({
    height: heightSV.value,
    marginTop: marginTopSV.value,
    marginBottom: marginBottomSV.value,
  }))

  if (totalCards === 0) return null

  return (
    <Animated.View style={[stylez, {alignItems: 'center'}]} testID={testID}>
      {snapshot.map((banner, index) => (
        <BannerCard
          key={banner.bannerId}
          banner={banner}
          locale={locale}
          index={index}
          totalLength={totalCards - 1}
          activeIndex={activeIndex}
          onClose={() => {
            dismissCountRef.current += 1
            dismissedIdsRef.current.add(banner.bannerId)
            onCloseCard?.(banner)
            const nextCount = dismissCountRef.current
            // After the height-collapse animation completes and every banner
            // in the snapshot has been dismissed, clear the snapshot so this
            // component returns null — otherwise the zero-height Animated.View
            // lingers as a flex item and compounds with the parent's `gap`.
            activeIndex.value = withTiming(nextCount, {duration: DISMISS_DURATION}, (finished) => {
              if (finished && nextCount >= totalCards) runOnJS(setSnapshot)([])
            })
          }}
          testID={banner.testID ?? (testID ? `${testID}-card-${index}` : undefined)}
        />
      ))}
    </Animated.View>
  )
}
