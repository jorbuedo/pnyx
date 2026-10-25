/**
 * BlobBackground component.
 *
 * Full-screen background that applies the theme's canvas color. The
 * blurred blue elliptical glow was removed as part of the v2 redesign —
 * the component is kept so it continues to satisfy existing consumers
 * (notably `SafeAreaViewWrapper`) without them having to switch to a
 * plain `View`.
 *
 * {@link BlobParallaxProvider} still wires through for back-compat with
 * the scroll-handlers on `DashboardAggregateView`, but there's nothing
 * left to parallax.
 *
 * @module
 */

import type {ReactNode} from 'react'
import {type StyleProp, View, type ViewStyle} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

export type BlobBackgroundProps = {
  /** Content to render on top of the themed canvas. */
  children?: ReactNode
  /** Additional styles applied to the outer container. */
  style?: StyleProp<ViewStyle>
}

export const BlobBackground = ({children, style}: BlobBackgroundProps) => (
  <View style={[styles.container, style]}>{children}</View>
)

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.backgroundDefault,
  },
}))
