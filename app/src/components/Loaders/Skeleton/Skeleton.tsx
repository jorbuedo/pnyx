/**
 * Skeleton component.
 *
 * A loading placeholder with configurable size and shape.
 *
 * @module
 */

import {memo} from 'react'
import {View, type ViewProps} from 'react-native'
import {SkeletonBase} from './SkeletonBase'

/** Shape options for the skeleton */
export type SkeletonShape = 'round' | 'square' | 'circle'

/** Shape presets, shared with SkeletonSquare so a name means the same thing in both. */
const shapeToBorderRadius: Record<SkeletonShape, number> = {
  square: 4,
  round: 12,
  circle: 999999,
}

export type SkeletonProps = {
  /** Child content to show when not loading */
  children: React.ReactNode | null
  /** Whether to show the skeleton animation */
  show?: boolean
  /** Width of the skeleton in pixels */
  width?: number
  /** Height of the skeleton in pixels */
  height?: number
  /** Custom border radius (overrides shape) */
  radius?: number
  /** Shape preset for border radius */
  shape?: SkeletonShape
  /** Props for the outer container view */
  containerProps?: ViewProps
  /** Test ID for e2e testing */
  testID?: string
}

/**
 * Skeleton component for loading states.
 *
 * Displays an animated shimmer placeholder when loading. Once loading is complete,
 * renders the children. Useful for content placeholders in lists, cards, etc.
 *
 * @example
 * ```tsx
 * // Show skeleton while loading
 * <Skeleton show={isLoading} width={200} height={20}>
 *   <Text>{data.title}</Text>
 * </Skeleton>
 *
 * // Circle shape for avatars
 * <Skeleton show={isLoading} width={48} height={48} shape="circle">
 *   <Avatar source={user.avatar} />
 * </Skeleton>
 * ```
 */
export const Skeleton = memo(
  ({
    width = 0,
    height = 0,
    show = false,
    children,
    containerProps = {},
    shape = 'square',
    radius,
    testID,
  }: SkeletonProps) => {
    return (
      <View {...(show ? containerProps : {})}>
        <SkeletonBase
          width={show ? width : 0}
          height={show ? height : 0}
          show={show}
          radius={radius ?? shapeToBorderRadius[shape]}
          testID={testID}
        >
          {show ? null : children}
        </SkeletonBase>
      </View>
    )
  },
)
