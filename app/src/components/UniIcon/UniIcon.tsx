/**
 * UniIcon component.
 *
 * A universal icon component that renders SVG icons via expo-image.
 * Supports icon names, HTTP URLs, size presets, and tint colors.
 *
 * @module
 */

import {Image as ExpoImage, type ImageSource, type ImageStyle} from 'expo-image'
import type React from 'react'
import type {ColorValue} from 'react-native'
import {withUnistyles} from 'react-native-unistyles'

import {allIconSources, type UniIconName} from './UniIcon.map'

/** Available icon size presets */
export type UniIconSize = 'xxs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl' | 'xxxl'

/** Icon variant - stroke (outline) or filled */
export type UniIconVariant = 'stroke' | 'filled'

/** Maps size names to pixel dimensions */
export const uniIconSizeMap: Record<UniIconSize, {width: number; height: number}> = {
  xxs: {width: 16, height: 16},
  xs: {width: 18, height: 18},
  sm: {width: 20, height: 20},
  md: {width: 24, height: 24},
  lg: {width: 32, height: 32},
  xl: {width: 40, height: 40},
  xxl: {width: 56, height: 56},
  xxxl: {width: 100, height: 100},
}

export type UniIconProps = {
  /** Icon name from the registry, or an HTTP/HTTPS URL */
  name: UniIconName | `http://${string}` | `https://${string}`
  /** Optional tint color for the icon */
  color?: ColorValue
  /** Custom styles for the icon */
  style?: ImageStyle
  /** Size preset */
  size?: UniIconSize
  /** Variant - 'stroke' (default) or 'filled' */
  variant?: UniIconVariant
  /** Override width (takes precedence over size) */
  width?: number
  /** Override height (takes precedence over size) */
  height?: number
  /** Test ID for e2e testing */
  testID?: string
}

/**
 * Converts ColorValue to string for tintColor prop.
 */
const colorToString = (color: ColorValue | undefined): string | null => {
  if (!color) return null
  if (typeof color === 'string') return color
  // For OpaqueColorValue, we can't extract the color
  return null
}

/**
 * UniIcon component for rendering icons.
 *
 * Supports two modes:
 * 1. Icon name lookup from the registry
 * 2. Direct HTTP/HTTPS URL for remote icons
 *
 * @example
 * ```tsx
 * // Using icon name
 * <UniIcon name="copy" size="md" color="#3154CB" />
 *
 * // Using filled variant
 * <UniIcon name="home" variant="filled" size="lg" />
 *
 * // Using URL
 * <UniIcon name="https://example.com/icon.svg" size="xl" />
 *
 * // Custom dimensions
 * <UniIcon name="wallet" width={48} height={48} />
 * ```
 */
const Icon = ({name, color, style, size = 'md', variant = 'stroke', width, height, testID}: UniIconProps) => {
  const dimensions = uniIconSizeMap[size]
  const tintColor = colorToString(color)
  const finalWidth = width ?? dimensions.width
  const finalHeight = height ?? dimensions.height

  // Handle URL icons
  if (typeof name === 'string' && (name.startsWith('http://') || name.startsWith('https://'))) {
    return (
      <ExpoImage
        source={{uri: name}}
        style={[style, {width: finalWidth, height: finalHeight}]}
        contentFit="contain"
        tintColor={tintColor}
        testID={testID}
      />
    )
  }

  // Build icon key for lookup
  const iconKey = variant === 'filled' ? `${name}Filled` : name

  // Widened because `name` also carries runtime-supplied keys (chain ids, remote slugs)
  // that are not in the union; the miss is handled below.
  const iconSource = (allIconSources as Record<string, ImageSource | undefined>)[iconKey]

  // If icon not found, return null
  if (!iconSource) {
    return null
  }

  return (
    <ExpoImage
      source={iconSource}
      style={[style, {width: finalWidth, height: finalHeight}]}
      contentFit="contain"
      tintColor={tintColor}
      testID={testID}
    />
  )
}

type UniIconStyledProps = Partial<UniIconProps> & {
  // biome-ignore lint/suspicious/noExplicitAny: theme and rt are used in the withUnistyles function
  uniProps?: (theme: any, rt: any) => Partial<Omit<UniIconProps, 'style' | 'contentContainerStyle'>> & {key?: string}
}

export const UniIcon = withUnistyles(Icon) as unknown as React.ComponentType<UniIconStyledProps>
