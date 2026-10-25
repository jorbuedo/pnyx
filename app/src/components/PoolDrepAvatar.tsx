/**
 * Circular avatar for a stake pool or DRep — a remote logo (cexplorer CDN, or a
 * verified DRep image) that falls back to an initials disc when the source is
 * absent or 404s. One component for every pool/DRep row and the stake target
 * cards.
 *
 * @module
 */

import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Image} from './Image'
import {Typography} from './Typography'

export type PoolDrepAvatarProps = {
  /** Remote logo URL (cexplorer / verified image); `null`/empty → initials only. */
  readonly imageUrl?: string | null
  /** Backs the initials fallback — ticker, name, or id. */
  readonly label: string
  /** Rendered edge in pt (default 40). */
  readonly size?: number
  readonly testID?: string
}

export const PoolDrepAvatar = ({imageUrl, label, size = 40, testID}: PoolDrepAvatarProps) => {
  const initials = (
    <View style={[styles.disc, {width: size, height: size, borderRadius: size / 2}]} testID={testID}>
      <Typography variant="bodyXs_medium" style={styles.discText} numberOfLines={1}>
        {label.slice(0, 2).toUpperCase()}
      </Typography>
    </View>
  )

  if (imageUrl === undefined || imageUrl === null || imageUrl.length === 0) return initials

  return (
    <Image
      source={imageUrl}
      width={size}
      height={size}
      style={{borderRadius: size / 2}}
      contentFit="cover"
      fallBackImage={initials}
      {...(testID !== undefined ? {testId: testID} : {})}
    />
  )
}

const styles = StyleSheet.create((theme) => ({
  disc: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.backgroundAlternative,
  },
  discText: {color: theme.colors.textMuted},
}))
