/**
 * Browser start page — shown when the active tab has no URL loaded.
 *
 * Centred hint copy mirroring the search overlay text. When the `discover` feature flag is enabled,
 * a list of curated dApp rows renders below the hint; tapping a row loads that URL into the active
 * tab, and the star on the right lifts a dApp to the top of the list.
 *
 * ⚠️ **Rows, not a grid.** A tile could not carry what a person needs to pick from a list: a
 * four-across grid left "Glacier Redeem" as "Glacier Red…" with nothing to say what the dApp is
 * for. A full-width row fits the whole name and its category underneath.
 *
 * The list is remote-config driven (`dapps.recommended` on config.pxkq.uk —
 * see docs/remote-config.md). There is no built-in fallback list, so before it
 * loads / if it's unavailable the list is simply absent and only the hint
 * copy renders.
 *
 * ⚠️ **Virtualized, and it has to be.** The curated list is ~200 entries and every row paints a
 * `ChamferBackground` — a `react-native-svg` layer that measures itself on the layout pass — plus a
 * remote icon. Mounting them all at once made scrolling visibly janky on device; a `ScrollView` over
 * `.map()` does exactly that, so rows go through `FlatList` and the hint is its header.
 *
 * Tapping the URL pill in the top bar opens the search overlay (which
 * has its own input + Cancel + the same hint copy + recents).
 *
 * @module
 */

import {memo, useCallback, useMemo} from 'react'
import {FlatList, Image, type ListRenderItemInfo, Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {discoverDappsFrom, discoverIconUri} from '../../config/discover-links'
import {useFeatureFlag} from '../../hooks/useFeatureFlag'
import {useI18n, useRemoteConfig} from '../../providers'
import {ChamferBackground} from '../Chamfer'
import {Typography} from '../Typography'
import {UniIcon} from '../UniIcon'
import {type FavouriteDapp, isFavourite, listForDisplay} from './dapp-favourites'

type BrowserStartPageProps = {
  onPickLink: (url: string) => void
  /** Shared with the browser menu, which stars the page you are on — see `useDappFavourites`. */
  favourites: readonly FavouriteDapp[]
  onToggleFavourite: (entry: FavouriteDapp) => void
}

export const BrowserStartPage = ({onPickLink, favourites, onToggleFavourite}: BrowserStartPageProps) => {
  const {t} = useI18n()
  const discoverEnabled = useFeatureFlag('discover')
  const {dapps} = useRemoteConfig()

  // Keyed on `dapps` alone: `discoverDappsFrom` maps to fresh objects, and rebuilding them on every
  // star would break `DappRow`'s memo for every mounted row.
  const curated = useMemo(() => discoverDappsFrom(dapps), [dapps])
  const links = useMemo(() => listForDisplay(favourites, curated), [curated, favourites])
  const data = discoverEnabled ? links : EMPTY

  const header = useMemo(
    () => (
      <Typography variant="bodyMd_regular" style={styles.hint}>
        {t('browser.startHint')}
      </Typography>
    ),
    [t],
  )

  const renderItem = useCallback(
    ({item}: ListRenderItemInfo<FavouriteDapp>) => (
      <DappRow
        dapp={item}
        isFavourite={isFavourite(favourites, item.id)}
        onOpen={onPickLink}
        onToggleFavourite={onToggleFavourite}
        favouriteLabel={isFavourite(favourites, item.id) ? t('browser.unfavourite') : t('browser.favourite')}
      />
    ),
    [favourites, onPickLink, onToggleFavourite, t],
  )

  return (
    <FlatList
      data={data}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      ListHeaderComponent={header}
      contentContainerStyle={styles.scroll}
      ItemSeparatorComponent={Separator}
      initialNumToRender={12}
      windowSize={7}
      removeClippedSubviews
    />
  )
}

const EMPTY: readonly FavouriteDapp[] = []
const keyExtractor = (dapp: FavouriteDapp) => dapp.id
const Separator = () => <View style={styles.separator} />

const styles = StyleSheet.create(({colors, spacing}) => ({
  scroll: {
    flexGrow: 1,
    paddingHorizontal: spacing.spacing24,
    paddingTop: spacing.spacing48,
    paddingBottom: spacing.spacing24,
  },
  hint: {
    color: colors.textAlternative,
    textAlign: 'center' as const,
    alignSelf: 'center' as const,
    maxWidth: 320,
    marginBottom: spacing.spacing32,
  },
  separator: {
    height: spacing.spacing8,
  },
  row: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: spacing.spacing12,
    paddingVertical: spacing.spacing12,
    paddingHorizontal: spacing.spacing16,
  },
  rowIcon: {
    width: 40,
    height: 40,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    overflow: 'hidden' as const,
  },
  icon: {
    width: 32,
    height: 32,
  },
  rowText: {
    flex: 1,
    gap: spacing.spacing2,
  },
  rowName: {
    color: colors.textDefault,
  },
  categories: {
    flexDirection: 'row' as const,
    flexWrap: 'wrap' as const,
    gap: spacing.spacing8,
  },
  category: {
    color: colors.textMuted,
  },
  star: {
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
}))

/**
 * One curated dApp: icon, name, what it is for, and a star.
 *
 * The star is its own pressable inside the row's pressable — nested on purpose, so the whole row
 * stays the tap target for opening the dApp while the star keeps a hit area of its own.
 */
const DappRow = memo(function DappRow({
  dapp,
  isFavourite,
  onOpen,
  onToggleFavourite,
  favouriteLabel,
}: {
  dapp: FavouriteDapp
  isFavourite: boolean
  onOpen: (url: string) => void
  onToggleFavourite: (dapp: FavouriteDapp) => void
  favouriteLabel: string
}) {
  const iconUri = discoverIconUri(dapp)
  const open = useCallback(() => onOpen(dapp.url), [onOpen, dapp.url])
  const toggle = useCallback(() => onToggleFavourite(dapp), [onToggleFavourite, dapp])
  return (
    <Pressable onPress={open} accessibilityRole="button" accessibilityLabel={dapp.name} style={styles.row}>
      <ChamferBackground size="auto" fillToken="backgroundAlternative" />
      <View style={styles.rowIcon}>
        {iconUri ? <Image source={{uri: iconUri}} style={styles.icon} resizeMode="contain" /> : null}
      </View>
      <View style={styles.rowText}>
        {/* Two lines rather than one: the whole point of the row is that a name no longer has to be
            truncated to fit four across. */}
        <Typography variant="bodyMd_medium" numberOfLines={2} style={styles.rowName}>
          {dapp.name}
        </Typography>
        {dapp.categories.length > 0 ? (
          <View style={styles.categories}>
            {dapp.categories.map((category) => (
              <Typography key={category} variant="bodyXs_regular" numberOfLines={1} style={styles.category}>
                {category}
              </Typography>
            ))}
          </View>
        ) : null}
      </View>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{selected: isFavourite}}
        accessibilityLabel={favouriteLabel}
        testID={`dapp-favourite-${dapp.id}`}
        hitSlop={12}
        style={styles.star}
      >
        <UniIcon
          name={isFavourite ? 'starFilled' : 'star'}
          size="md"
          uniProps={(theme) => ({color: isFavourite ? theme.colors.primaryDefault : theme.colors.iconMuted})}
        />
      </Pressable>
    </Pressable>
  )
})
