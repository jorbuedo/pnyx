/**
 * Image component.
 *
 * An expo-image wrapper with error handling and fallback support.
 *
 * @module
 */

import {
  Image as ExpoImage,
  type ImageProps as ExpoImageProps,
  type ImageErrorEventData,
  type ImageRef,
  type ImageSource,
  type ImageStyle,
} from 'expo-image'
import type {ReactElement} from 'react'
import {useState} from 'react'

export type ImageSrc = ImageSource | ImageRef | string | number | null | undefined

export type ImageProps = Omit<ExpoImageProps, 'style'> & {
  /** Width of the image in pixels */
  width?: number
  /** Height of the image in pixels */
  height?: number
  /** Custom styles for the image */
  style?: ImageStyle
  /** Callback when image fails to load */
  onError?: (error: ImageErrorEventData) => void
  /** Fallback element to render when image fails to load or source is empty */
  fallBackImage?: ReactElement | null
  /** Test ID for e2e testing */
  testId?: string
}

/**
 * Checks if an image source is valid.
 */
const isValidSource = (source: ExpoImageProps['source']): boolean => {
  if (!source) return false
  if (typeof source === 'string') return source.length > 0
  if (typeof source === 'number') return true
  if (Array.isArray(source)) return source.length > 0
  // An already-decoded `ImageRef` (from `useImage`) is a `SharedRef`, and carries no `uri` to test —
  // on web it does carry one, and it is null there, so the check below would reject a valid image.
  if (typeof source === 'object' && 'nativeRefType' in source) return true
  if (typeof source === 'object' && 'uri' in source) return typeof source.uri === 'string' && source.uri.length > 0
  return true
}

/**
 * Image component with automatic fallback on error.
 *
 * Wraps expo-image with error state management. When the image fails to load
 * or the source is empty/invalid, renders the fallback element instead.
 *
 * @example
 * ```tsx
 * <Image
 *   source={{ uri: 'https://example.com/image.png' }}
 *   width={100}
 *   height={100}
 *   fallBackImage={<Placeholder />}
 * />
 *
 * <Image
 *   source={require('./local-image.png')}
 *   width={64}
 *   height={64}
 * />
 * ```
 */
export const Image = ({
  source,
  style,
  onError,
  fallBackImage = null,
  height = 16,
  width = 16,
  contentFit = 'fill',
  cachePolicy = 'memory-disk',
  ...restExpoImageProps
}: ImageProps) => {
  const [errorImage, setErrorImage] = useState<boolean>(false)

  const handleError = (error: ImageErrorEventData) => {
    setErrorImage(true)
    onError?.(error)
  }

  if (errorImage || !isValidSource(source) || source === undefined) {
    return <>{fallBackImage}</>
  }

  return (
    <ExpoImage
      {...restExpoImageProps}
      source={source}
      style={[style, {width, height}]}
      onError={handleError}
      contentFit={contentFit}
      cachePolicy={cachePolicy}
    />
  )
}
