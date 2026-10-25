/**
 * Red attention dot tied to the notice registry.
 *
 * Drop `<NoticeDot route="/settings" />` next to any nav surface. Renders
 * a small error-colored dot iff any active notice is anchored at `route`
 * or at a deeper descendant route.
 *
 * `position` defaults to `'absolute'` so callers can overlay the dot on
 * an icon without touching its layout. Pass `position="static"` to place
 * it inline in a flex row.
 *
 * @module
 */

import {View, type ViewStyle} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useNoticeDot} from './useNoticeDot'

export type NoticeDotProps = {
  /** Route(s) this dot watches — several when one surface leads to several subtrees. See
   * {@link useNoticeDot} and {@link module:./nav-routes}. */
  readonly route: string | readonly string[]
  /** Layout mode. `absolute` (default) overlays; `static` participates in flex layout. */
  readonly position?: 'absolute' | 'static'
  /** Dot diameter in px. Defaults to 8. */
  readonly size?: number
  /** Extra style for fine-tuning position when `position='absolute'`. */
  readonly style?: ViewStyle
  readonly testID?: string
}

export const NoticeDot = ({route, position = 'absolute', size = 8, style, testID}: NoticeDotProps) => {
  const show = useNoticeDot(route)
  if (!show) return null
  return (
    <View
      style={[styles.base(size), position === 'absolute' ? styles.absolute : null, style]}
      testID={testID ?? `notice-dot-${typeof route === 'string' ? route : route.join(',')}`}
    />
  )
}

const styles = StyleSheet.create((theme) => ({
  base: (size: number) => ({
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: theme.colors.errorDefault,
  }),
  absolute: {
    position: 'absolute' as const,
    top: 0,
    right: 0,
  },
}))
