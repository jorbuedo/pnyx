/**
 * SkeletonSquare component.
 *
 * A square skeleton loading placeholder (equal width and height).
 *
 * @module
 */

import {memo} from 'react'
import {SkeletonBase} from './SkeletonBase'

/** Shape options — same vocabulary and same values as {@link Skeleton}. */
export type SkeletonSquareShape = 'square' | 'round' | 'circle'

const shapeToBorderRadius: Record<SkeletonSquareShape, number> = {
  square: 4,
  round: 12,
  circle: 999999,
}

export type SkeletonSquareProps = {
  /** Child content to show when not loading */
  children: React.ReactNode | null
  /** Whether to show the skeleton animation */
  show?: boolean
  /** Size of the square (width and height) in pixels */
  size?: number
  /** Custom border radius (overrides shape) */
  radius?: number
  /** Shape preset for border radius */
  shape?: SkeletonSquareShape
  /** Test ID for e2e testing */
  testID?: string
}

/**
 * SkeletonSquare component for square loading placeholders.
 *
 * A convenience wrapper around SkeletonBase that ensures equal width and height.
 * Useful for avatar placeholders, icon placeholders, and other square content.
 *
 * @example
 * ```tsx
 * // Square icon placeholder
 * <SkeletonSquare show={isLoading} size={24}>
 *   <Icon name="star" />
 * </SkeletonSquare>
 *
 * // Circular avatar placeholder
 * <SkeletonSquare show={isLoading} size={48} shape="circle">
 *   <Avatar source={user.avatar} />
 * </SkeletonSquare>
 * ```
 */
export const SkeletonSquare = memo(
  ({size = 0, show = false, children, shape = 'square', radius, testID}: SkeletonSquareProps) => {
    return (
      <SkeletonBase
        width={size}
        height={size}
        show={show}
        radius={radius ?? shapeToBorderRadius[shape]}
        testID={testID}
      >
        {show ? null : children}
      </SkeletonBase>
    )
  },
)
