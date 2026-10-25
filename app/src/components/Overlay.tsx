/**
 * Overlay component.
 *
 * A full-screen overlay backdrop with blur effect.
 * Used for modals, drawers, and other overlaid content.
 *
 * @module
 */

import {BlurView} from 'expo-blur'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {platformIsWeb} from '../platform'

const DEFAULT_INTENSITY = 2

export type OverlayProps = {
  /** Blur intensity (0-100) */
  intensity?: number
  /** Callback when the overlay is pressed */
  onPress?: () => void
  /** Test ID for e2e testing */
  testID?: string
}

/**
 * Overlay component for modal backdrops.
 *
 * Renders a full-screen blur overlay that can be pressed to dismiss.
 * Uses expo-blur on native and CSS backdrop-filter on web.
 *
 * @example
 * ```tsx
 * <Modal visible={isOpen}>
 *   <Overlay onPress={() => setIsOpen(false)} />
 *   <ModalContent />
 * </Modal>
 * ```
 */
export const Overlay = ({intensity = DEFAULT_INTENSITY, onPress, testID}: OverlayProps) => {
  const content = (
    <Pressable onPress={onPress} style={styles.pressable} testID={testID}>
      <View style={styles.overlay} />
    </Pressable>
  )

  if (platformIsWeb) {
    return <View style={[styles.container, styles.containerWeb(intensity)]}>{content}</View>
  }

  return (
    <BlurView intensity={intensity} style={styles.container}>
      {content}
    </BlurView>
  )
}

const styles = StyleSheet.create(({colors}) => ({
  container: {
    flex: 1,
    position: 'absolute',
    width: '100%',
    height: '100%',
  },
  containerWeb: (intensity: number) => ({
    _web: {
      backdropFilter: `blur(${intensity / 2}px)`,
    },
  }),
  pressable: {
    width: '100%',
    height: '100%',
  },
  overlay: {
    flex: 1,
    backgroundColor: colors.overlayDefault,
  },
}))
