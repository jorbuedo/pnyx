/**
 * BannerCard component.
 *
 * v2 layout — matches the `MidnightAirdropBanner` / `HomeCardModule`
 * row pattern:
 *
 *   [icon 40×40 ←]  [title / description (wraps, no clamp)]  [chevron →]
 *                                                             [dismiss ×]
 *
 * Icon moves from right-pinned illustration to a small rounded square
 * on the left. Title + description get the v2 typography tokens and
 * allow wrapping. When the banner is tappable (`type: 'link'` or
 * `'navigation'` with a `destination`), the inline text `actionLabel`
 * is dropped in favor of a right-aligned chevron — the whole row is
 * Pressable. Set `hideChevron` to suppress the chevron while keeping
 * the tap behavior (used by remote banners). Dismissible banners keep
 * the top-right `×`.
 *
 * @module
 */

import {type Href, router} from 'expo-router'
import {Linking, Pressable, View} from 'react-native'
import Animated, {
  Extrapolation,
  interpolate,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated'
import {StyleSheet, useUnistyles} from 'react-native-unistyles'

import {Card} from '../Card'
import {ChamferBackground} from '../Chamfer'
import {Image} from '../Image'
import {Typography} from '../Typography'
import {UniIcon} from '../UniIcon'

export type MultiLangText = Record<string, string>

export type BannerActionType = 'link' | 'navigation'

export type Banner = {
  bannerId: string
  title: MultiLangText | string
  description: MultiLangText | string
  /** @deprecated v2 banners use the right chevron affordance instead of an inline CTA label. Kept for back-compat with remote-config payloads; the value is ignored at render time. */
  actionLabel?: MultiLangText | string | undefined
  imageUrl?: string | number | undefined
  isDismissible: boolean
  priorityWeight: number
  testID?: string | undefined
  dismissTestID?: string | undefined
  /**
   * - `undefined`    — card is not tappable
   * - `'link'`       — opens `destination` in the system browser via Linking
   * - `'navigation'` — navigates to `destination` via expo-router
   */
  type?: BannerActionType | undefined
  destination?: string | undefined
  /** When true, suppress the right-aligned chevron even if the card is tappable. */
  hideChevron?: boolean | undefined
}

export const CARD_HEIGHT = 96
const ICON_SIZE = 40

const resolveText = (text: MultiLangText | string, locale: string): string => {
  if (typeof text === 'string') return text
  return text[locale] ?? text.en ?? Object.values(text)[0] ?? ''
}

export type BannerCardProps = {
  banner: Banner
  locale?: string | undefined
  index: number
  totalLength: number
  activeIndex: SharedValue<number>
  onClose: () => void
  testID?: string | undefined
}

export const BannerCard = ({
  banner,
  locale = 'en',
  index,
  totalLength,
  activeIndex,
  onClose,
  testID,
}: BannerCardProps) => {
  const {theme} = useUnistyles()
  const fillColor = theme.colors.backgroundLayer1
  const iconFill = theme.colors.backgroundAlternative
  const closeFill = `${theme.colors.backgroundAlternative}${theme.colorAlpha[38]}`
  const isVisible = useSharedValue(true)

  const title = resolveText(banner.title, locale)
  const description = resolveText(banner.description, locale)

  const {destination} = banner
  const handlePress: (() => void) | undefined =
    destination && (banner.type === 'link' || banner.type === 'navigation')
      ? () => {
          if (banner.type === 'link') {
            void Linking.openURL(destination)
          } else {
            router.navigate(destination as Href)
          }
        }
      : undefined

  // Only one card is visible at a time — stacking / peek chrome is
  // dropped per the redesign. A cross-fade is still allowed during a
  // dismiss: the outgoing card fades 1→0 while the incoming card fades
  // 0→1. Fully hidden cards use `display: 'none'` so their shape
  // doesn't leak layout or a11y.
  useAnimatedReaction(
    () => activeIndex.value,
    (current) => {
      isVisible.value = current > index - 1 && current < index + 1
    },
  )

  const stylez = useAnimatedStyle(() => {
    return {
      opacity: interpolate(activeIndex.value, [index - 1, index, index + 1], [0, 1, 0], Extrapolation.CLAMP),
      display: isVisible.value ? ('flex' as const) : ('none' as const),
    }
  })

  const cardContent = (
    <>
      {banner.imageUrl ? (
        <View style={styles.iconWrap}>
          <ChamferBackground size="auto" fill={iconFill} />
          <Image
            source={typeof banner.imageUrl === 'string' ? {uri: banner.imageUrl} : banner.imageUrl}
            contentFit="contain"
            width={ICON_SIZE}
            height={ICON_SIZE}
          />
        </View>
      ) : null}

      <View style={[styles.text, banner.isDismissible && styles.textWithDismissPad]}>
        <Typography variant="bodyMd_bold" style={styles.title} numberOfLines={1}>
          {title}
        </Typography>
        {description ? (
          <Typography variant="bodySm_regular" style={styles.description} numberOfLines={2}>
            {description}
          </Typography>
        ) : null}
      </View>

      {handlePress && !banner.hideChevron ? (
        <View style={[styles.chevron, {pointerEvents: 'none'}]}>
          <UniIcon name="chevronRight" size="md" uniProps={(theme) => ({color: theme.colors.textAlternative})} />
        </View>
      ) : null}
    </>
  )

  return (
    <Animated.View style={[styles.container(totalLength, index), stylez]} testID={testID}>
      <Card
        fill={fillColor}
        style={[styles.pressable, styles.pressableContent]}
        {...(handlePress ? {onPress: handlePress, accessibilityRole: 'button' as const} : {})}
      >
        {cardContent}
      </Card>
      {banner.isDismissible ? (
        <Pressable
          style={styles.closeButton}
          onPress={() => {
            onClose()
          }}
          accessibilityRole="button"
          testID={banner.dismissTestID}
          hitSlop={8}
        >
          <ChamferBackground size="auto" fill={closeFill} />
          <UniIcon name="close" size="sm" uniProps={(theme) => ({color: theme.colors.textAlternative})} />
        </Pressable>
      ) : null}
    </Animated.View>
  )
}

const styles = StyleSheet.create(({spacing, colors}) => ({
  container: (totalLength: number, index: number) => ({
    position: 'absolute' as const,
    left: 0,
    right: 0,
    height: CARD_HEIGHT,
    zIndex: totalLength - index,
  }),
  pressable: {
    flex: 1,
  },
  // Row contents of the card — split out so the pressable wrapper can
  // apply the translucent surface while the row layout stays consistent
  // across tappable and non-tappable variants.
  pressableContent: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: spacing.spacing12,
    padding: spacing.spacing12,
  },
  iconWrap: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  text: {
    flex: 1,
    gap: spacing.spacing2,
  },
  // Dismiss button sits absolutely in the top-right. Reserve room so the
  // description copy can't underlap it when wrapping to 2 lines.
  textWithDismissPad: {
    paddingRight: spacing.spacing24,
  },
  title: {
    color: colors.textDefault,
  },
  description: {
    color: colors.textAlternative,
  },
  chevron: {
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  closeButton: {
    position: 'absolute' as const,
    top: spacing.spacing8,
    right: spacing.spacing8,
    zIndex: 3,
    padding: spacing.spacing4,
  },
}))
