/**
 * Cross-platform blur overlay for hide/reveal surfaces (recovery phrase,
 * compromised receive address, …).
 *
 * expo-blur v55 only renders a real blur on iOS and Android 12+ (SDK 31);
 * web has no native blur so we fall back to CSS `backdrop-filter`, and older
 * Android to an opaque tint. Wrap the maskable content in `BlurTargetView`
 * (only needed on Android — see `androidSupportsBlur`) so the blur has a
 * source to sample.
 *
 * @module
 */

import {BlurView} from 'expo-blur'
import type {ComponentProps, RefObject} from 'react'
import {Platform, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {platformIsAndroid, platformIsWeb} from '../platform'

/** expo-blur v55 only renders a real blur on Android 12+ (SDK 31). */
export const androidSupportsBlur = platformIsAndroid && Number(Platform.Version) >= 31

export const BlurRevealOverlay = ({blurTarget}: {blurTarget: RefObject<View | null>}) => {
  if (platformIsWeb) {
    return <View style={styles.blurOverlayWeb} />
  }
  if (platformIsAndroid) {
    // v55 needs a blurTarget to render a real blur; SDK < 31 has none, so a
    // tinted panel keeps the content unreadable there.
    return androidSupportsBlur ? (
      <BlurView
        blurMethod="dimezisBlurViewSdk31Plus"
        // Cast: expo-blur is hoisted against the workspace-root react-native
        // types (0.86) while this app pins 0.83 — same host View at runtime.
        blurTarget={blurTarget as NonNullable<ComponentProps<typeof BlurView>['blurTarget']>}
        intensity={50}
        style={[styles.blurOverlay, styles.blurOverlayAndroidBlur]}
      />
    ) : (
      <View style={[styles.blurOverlay, styles.blurOverlayAndroidFallback]} />
    )
  }
  return <BlurView intensity={20} style={styles.blurOverlay} />
}

const styles = StyleSheet.create((theme) => ({
  blurOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
  },
  blurOverlayAndroidBlur: {
    backgroundColor: `${theme.colors.backgroundAlternative}4D`,
  },
  blurOverlayAndroidFallback: {
    backgroundColor: `${theme.colors.backgroundAlternative}E6`,
  },
  blurOverlayWeb: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
    backgroundColor: `${theme.colors.backgroundAlternative}CC`,
    _web: {
      backdropFilter: 'blur(8px)',
    },
  },
}))
