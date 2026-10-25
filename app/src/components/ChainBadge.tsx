/**
 * A token icon with its chain's badge in the corner.
 *
 * The one way a merged list says which chain a row came from. Once Cardano and Midnight holdings sit in
 * the same asset list — and the same activity list — the row's own icon no longer answers "which chain",
 * and a text label per row would cost more space than it earns.
 *
 * ⚠️ **Cardano rows carry no badge.** It is the funds chain the app was built around and the overwhelming
 * majority of rows; badging every one of them would make the badge mean "row" rather than "chain". The
 * badge marks what is *not* the default, which is also why `chain` is optional.
 *
 * @module
 */

import {CARDANO_MAINNET, type ChainId} from '@pnyx/config'
import type {ReactNode} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {hasNetworkIcon, NetworkIcon} from './NetworkIcon'

export type ChainBadgeProps = {
  /** The row's own icon — a token icon, an avatar, whatever the surface already renders. */
  readonly children: ReactNode
  /** Absent, or Cardano, renders no badge. */
  readonly chain?: ChainId | undefined
  /** Badge diameter. 16 over a 36px row icon: smaller than that and the chain glyph stops being legible. */
  readonly size?: number
  readonly testID?: string | undefined
}

export const ChainBadge = ({children, chain, size = 16, testID}: ChainBadgeProps) => {
  const show = chain !== undefined && chain !== CARDANO_MAINNET && hasNetworkIcon(chain)
  if (!show) return <>{children}</>
  return (
    <View style={styles.wrap} testID={testID}>
      {children}
      <View style={styles.badge(size)}>
        <NetworkIcon chain={chain} size={size} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  wrap: {
    position: 'relative',
  },
  badge: (size: number) => ({
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: size,
    height: size,
    // 9999, not size/2: the badge is a circle at any size, and a computed radius reads to the chamfer
    // guard as a rounded rectangle it should have cut.
    borderRadius: 9999,
    overflow: 'hidden',
    // A ring in the surface colour, so the badge reads as sitting *on* the icon rather than blending
    // into whatever the icon's edge happens to be.
    borderWidth: 1,
    borderColor: theme.colors.backgroundDefault,
    backgroundColor: theme.colors.backgroundDefault,
  }),
}))
