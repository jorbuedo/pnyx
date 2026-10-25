/**
 * Canonical Cardano token icon. One component for every list/row/review surface
 * (portfolio, wallets, send, asset picker, history, tx review): ADA renders the
 * Cardano network icon; a native token renders its downscaled cached icon when
 * one resolves, else an initials disc (first three label chars). Icon
 * resolution + caching lives in `useTokenIconUri`.
 *
 * @module
 */

import {CARDANO_MAINNET} from '@pnyx/config'
import {useImage} from 'expo-image'
import {type ReactElement, useEffect} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {logger} from '../logger'
import {
  ADA_ASSET_IDS,
  ftPlaceholderIconUri,
  isCexplorerPlaceholder,
  nftPlaceholderIconUri,
  rememberIconlessAsset,
  useTokenIconUri,
} from '../services/cardano-assets'
import {useIsDark} from '../theme'
import {Image} from './Image'
import {NetworkIcon} from './NetworkIcon'
import {Typography} from './Typography'
import {hasTokenIconOverride, resolveTokenIconOverride} from './token-icon-override'

export type TokenIconProps = {
  /** App asset id (`"policyHex.assetNameHex"`), or `''`/`'.'` for ADA. */
  assetId: string
  /** Display label — its first three chars back the initials fallback. */
  label: string
  /** Rendered edge in pt (default 36). */
  size?: number
  /**
   * Known to be an NFT, so the CDN chain is skipped for a shipped placeholder.
   *
   * ⚠️ Passed by the caller rather than derived here: the row already holds the asset, and deciding
   * it from an id alone would need a per-asset fetch — one per row, which is the cost this avoids.
   */
  isNft?: boolean
  testID?: string
}

/**
 * The theme-swapped local override, in its own component.
 *
 * ⚠️ **So that only the rows that have one subscribe to the theme.** Reading light-from-dark needs
 * `useUnistyles()`, which opts the caller out of Unistyles' native shadow-tree update and re-renders
 * it in JS on every runtime notification. Called from `TokenIcon` itself, every icon in a list paid
 * that — 321ms inclusive while scrolling the whale's holdings, so that one policy (NIGHT) could pick
 * between two glyphs.
 */
const OverriddenTokenIcon = ({assetId, initials, dims, testIdProp}: OverriddenProps) => {
  const isDark = useIsDark()
  const override = resolveTokenIconOverride(assetId, isDark)
  if (override === null) return initials
  return <Image source={override} {...dims} contentFit="contain" fallBackImage={initials} {...testIdProp} />
}

type OverriddenProps = {
  readonly assetId: string
  readonly initials: ReactElement
  readonly dims: Record<string, unknown>
  readonly testIdProp: Record<string, unknown>
}

export const TokenIcon = ({assetId, label, size = 36, isNft, testID}: TokenIconProps) => {
  const isAda = ADA_ASSET_IDS.has(assetId)
  // A pure id test — no theme read, so no subscription for the icons that have no override.
  const hasOverride = !isAda && hasTokenIconOverride(assetId)
  // Skip the CDN fetch for ADA and overridden tokens (the hook must still run
  // unconditionally — empty id yields no sources without a request).
  const {primary, fallback} = useTokenIconUri(isAda || hasOverride ? '' : assetId, isNft === true ? {isNft: true} : {})

  if (isAda) return <NetworkIcon chain={CARDANO_MAINNET} size={size} />

  const testIdProp = testID !== undefined ? {testId: testID} : {}
  const dims = {width: size, height: size, style: {borderRadius: size / 2}, contentFit: 'cover' as const}

  const initials = (
    <View style={[styles.disc, {width: size, height: size, borderRadius: size / 2}]} testID={testID}>
      <Typography variant="bodyXs_medium" style={styles.discText} numberOfLines={1}>
        {label.slice(0, 3).toUpperCase()}
      </Typography>
    </View>
  )

  if (hasOverride) {
    return <OverriddenTokenIcon assetId={assetId} initials={initials} dims={dims} testIdProp={testIdProp} />
  }

  /**
   * What stands in when there is no real icon: an NFT gets the shipped mark, anything else its own
   * initials — which say more than a grey circle, and which cexplorer's placeholder had been masking.
   */
  const noIcon = (
    <Image
      source={isNft === true ? nftPlaceholderIconUri() : ftPlaceholderIconUri()}
      {...dims}
      fallBackImage={initials}
      {...testIdProp}
    />
  )

  // Chain SteelSwap → cexplorer → ours.
  const cexplorerNode =
    fallback !== null ? (
      <CexplorerTokenIcon assetId={assetId} url={fallback} noIcon={noIcon} dims={dims} testIdProp={testIdProp} />
    ) : (
      noIcon
    )

  if (primary === null) return cexplorerNode

  return <Image source={primary} {...dims} fallBackImage={cexplorerNode} {...testIdProp} />
}

type CexplorerProps = {
  readonly assetId: string
  readonly url: string
  readonly noIcon: ReactElement
  readonly dims: Record<string, unknown>
  readonly testIdProp: Record<string, unknown>
}

/**
 * The cexplorer step — loaded before it is shown.
 *
 * ⚠️ **`useImage`, not `<Image source={url}>`, so the CDN's placeholder is never painted.** cexplorer
 * answers 200 with an image whether or not it has one, so a failed load never happens and every
 * asset it has never seen decodes to its generic grey circle. Rendering first and classifying in
 * `onLoad` therefore showed somebody else's placeholder for a frame on every first sight.
 * `useImage` decodes off-screen and hands back the ref carrying the size the verdict reads — the
 * same single load and the same single decode, read before it reaches the screen. Ours stands in
 * meanwhile, which for the ~92% with no logo is where the row ends up anyway.
 */
const CexplorerTokenIcon = ({assetId, url, noIcon, dims, testIdProp}: CexplorerProps) => {
  const loaded = useImage(url, {
    onError: (e) => logger.warn('cexplorer icon did not load', {origin: 'TokenIcon', assetId, error: String(e)}),
  })
  const isPlaceholder = loaded !== null && isCexplorerPlaceholder(loaded)

  // Remembered as well as suppressed: a recycled row must not re-request what has no icon.
  useEffect(() => {
    if (isPlaceholder) rememberIconlessAsset(assetId)
  }, [isPlaceholder, assetId])

  if (loaded === null || isPlaceholder) return noIcon
  return <Image source={loaded} {...dims} fallBackImage={noIcon} {...testIdProp} />
}

const styles = StyleSheet.create((theme) => ({
  disc: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.backgroundAlternative,
  },
  discText: {color: theme.colors.textMuted},
}))
