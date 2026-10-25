/**
 * An asset's own media, shown where a price chart makes no sense — an NFT has no
 * market series, it has a picture. Renders nothing when the media cannot be
 * resolved, so the surface degrades to the rest of the detail rather than to a
 * broken frame.
 *
 * **Detail screens only.** Each instance is a gateway fetch, so this must not go
 * in a list — see the note in `services/cardano-assets/media.ts`.
 *
 * @module
 */

import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {assetMediaUrl} from '../services/cardano-assets/media'
import {Image} from './Image'

export type AssetMediaProps = {
  /** The minter's media URI, when the metadata carried one. */
  readonly image?: string | undefined
  /** Rendered edge in pt. */
  readonly size?: number
  readonly testID?: string
}

export const AssetMedia = ({image, size = 240, testID}: AssetMediaProps) => {
  const url = assetMediaUrl({image})
  if (url === null) return null
  return (
    <View style={styles.frame} testID={testID}>
      <Image source={{uri: url}} width={size} height={size} contentFit="contain" fallBackImage={null} />
    </View>
  )
}

const styles = StyleSheet.create(({spacing, colors}) => ({
  frame: {
    alignSelf: 'center',
    padding: spacing.spacing8,
    borderRadius: spacing.spacing16,
    backgroundColor: colors.backgroundAlternative,
    overflow: 'hidden',
  },
}))
