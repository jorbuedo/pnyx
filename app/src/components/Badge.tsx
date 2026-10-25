/**
 * Badge component.
 *
 * A versatile badge for displaying icons, counts, or status indicators.
 *
 * @module
 */

import type {ImageSource} from 'expo-image'
import type {ReactNode} from 'react'
import {isValidElement} from 'react'
import type {ViewStyle} from 'react-native'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Image} from './Image'
import {Typography} from './Typography'
import {UniIcon, type UniIconProps} from './UniIcon'

/** Available badge sizes */
export type BadgeSize = 'xl' | 'lg' | 'md' | 'sm'

/** Status indicator types */
export type BadgeStatus = 'error' | 'warning' | 'success' | 'primary' | 'muted'

/** Status dot size options */
export type DotSize = 'md' | 'sm' | 'xs'

/** Status dot background variant */
export type StatusDotVariant = 'default' | 'alternative'

/** Size to dimension mapping */
const sizeToCircleContainer: Record<BadgeSize, {width: number; height: number; fontSize: number; lineHeight: number}> =
  {
    sm: {width: 13, height: 13, fontSize: 10, lineHeight: 12},
    md: {width: 18, height: 18, fontSize: 12, lineHeight: 16},
    lg: {width: 22, height: 22, fontSize: 14, lineHeight: 20},
    xl: {width: 24, height: 24, fontSize: 14, lineHeight: 22},
  }

export type BadgeProps = {
  /** Icon source (image, icon name, or React element) */
  icon?: ImageSource | ReactNode | undefined
  /** Props to pass to the icon */
  iconProps?: Omit<UniIconProps, 'name'> | undefined
  /** Count to display (capped at 99+) */
  networkCount?: number | undefined
  /** Badge size preset */
  size?: BadgeSize | undefined
  /** Status indicator type (renders as dot instead of badge) */
  status?: BadgeStatus | undefined
  /** Additional style */
  style?: ViewStyle | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
  /** Size of the status dot */
  statusDotSize?: DotSize | undefined
  /** Background variant for status dot */
  statusDotVariant?: StatusDotVariant | undefined
}

const renderIcon = (icon: ImageSource | ReactNode | undefined, iconProps?: Omit<UniIconProps, 'name'>) => {
  if (!icon) return null

  // React element
  if (typeof icon === 'object' && isValidElement(icon)) {
    return icon
  }

  // String icon name
  if (typeof icon === 'string') {
    return <UniIcon name={icon as UniIconProps['name']} {...iconProps} width={17} height={17} />
  }

  // Image source (number from require() or object with uri)
  return <Image source={icon as ImageSource} style={imageStyles.image} width={17} height={17} />
}

const imageStyles = StyleSheet.create(({borderRadius}) => ({
  image: {
    borderRadius: borderRadius.roundedCircle,
  },
}))

/**
 * StatusDot component.
 *
 * Internal component for rendering status indicator dots.
 */
const StatusDot = ({
  status,
  dotSize,
  variant,
  style,
}: {
  status: BadgeStatus
  dotSize: DotSize
  variant: StatusDotVariant
  style?: ViewStyle | undefined
}) => {
  dotStyles.useVariants({
    size: dotSize,
    variant: variant === 'default' ? 'primary' : variant,
    status,
  })

  return (
    <View style={[dotStyles.container, style]}>
      <View style={dotStyles.dot} />
    </View>
  )
}

const dotStyles = StyleSheet.create(({borderRadius, colors}) => ({
  container: {
    alignItems: 'center',
    borderRadius: borderRadius.roundedCircle,
    justifyContent: 'center',
    position: 'absolute',
    variants: {
      size: {
        sm: {width: 10, height: 10, top: 0, right: 0},
        md: {width: 12, height: 12, top: -3, right: -2},
        xs: {width: 4, height: 4, top: 4, right: 4},
      },
      variant: {
        primary: {backgroundColor: colors.backgroundDefault},
        alternative: {backgroundColor: colors.backgroundAlternative},
      },
    },
  },
  dot: {
    borderRadius: borderRadius.roundedCircle,
    variants: {
      size: {
        sm: {width: 8, height: 8},
        md: {width: 10, height: 10},
        xs: {width: 4, height: 4},
      },
      status: {
        error: {backgroundColor: colors.errorDefault},
        warning: {backgroundColor: colors.warningDefault},
        success: {backgroundColor: colors.successDefault},
        primary: {backgroundColor: colors.primaryDefault},
        muted: {backgroundColor: colors.iconMuted},
      },
    },
  },
}))

/**
 * Badge component.
 *
 * Displays an icon, count, or status indicator in a circular badge.
 *
 * @example
 * ```tsx
 * // Icon badge
 * <Badge icon="star" size="md" />
 *
 * // Count badge
 * <Badge networkCount={5} size="sm" />
 *
 * // Status indicator
 * <Badge status="success" />
 * ```
 */
export const Badge = ({
  icon,
  iconProps,
  networkCount,
  size = 'md',
  status,
  style,
  testID,
  statusDotSize = 'sm',
  statusDotVariant = 'alternative',
}: BadgeProps) => {
  styles.useVariants({size})

  const exceededCount = networkCount != null && networkCount > 99
  const extendedWidth = exceededCount ? 10 : 0

  // Status mode renders just a dot
  if (status) {
    return <StatusDot status={status} dotSize={statusDotSize} variant={statusDotVariant} style={style} />
  }

  return (
    <View style={[styles.container(extendedWidth), style]} testID={testID}>
      {networkCount != null ? (
        <View style={styles.networkCount(extendedWidth)}>
          <Typography style={styles.typography}>{exceededCount ? '99+' : String(networkCount)}</Typography>
        </View>
      ) : icon ? (
        renderIcon(icon, iconProps)
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create(({borderRadius, borderWidth, colors}) => ({
  container: (extendedWidth: number) => ({
    backgroundColor: colors.backgroundAlternative,
    borderColor: colors.backgroundAlternative,
    borderWidth: borderWidth.s,
    borderRadius: borderRadius.roundedCircle,
    alignItems: 'center',
    justifyContent: 'center',
    variants: {
      size: {
        sm: {
          width: sizeToCircleContainer.sm.width + extendedWidth,
          height: sizeToCircleContainer.sm.height,
        },
        md: {
          width: sizeToCircleContainer.md.width + extendedWidth,
          height: sizeToCircleContainer.md.height,
        },
        lg: {
          width: sizeToCircleContainer.lg.width + extendedWidth,
          height: sizeToCircleContainer.lg.height,
        },
        xl: {
          width: sizeToCircleContainer.xl.width + extendedWidth,
          height: sizeToCircleContainer.xl.height,
        },
      },
    },
  }),
  networkCount: (extendedWidth: number) => ({
    borderRadius: borderRadius.roundedCircle,
    backgroundColor: colors.primaryDefault,
    flexDirection: 'row' as const,
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
    variants: {
      size: {
        sm: {
          width: sizeToCircleContainer.sm.width + extendedWidth - 2,
          height: sizeToCircleContainer.sm.height - 2,
        },
        md: {
          width: sizeToCircleContainer.md.width + extendedWidth - 2,
          height: sizeToCircleContainer.md.height - 2,
        },
        lg: {
          width: sizeToCircleContainer.lg.width + extendedWidth - 2,
          height: sizeToCircleContainer.lg.height - 2,
        },
        xl: {
          width: sizeToCircleContainer.xl.width + extendedWidth - 2,
          height: sizeToCircleContainer.xl.height - 2,
        },
      },
    },
  }),
  typography: {
    fontWeight: '500',
    color: colors.primaryInverse,
    variants: {
      size: {
        sm: {fontSize: sizeToCircleContainer.sm.fontSize, lineHeight: sizeToCircleContainer.sm.lineHeight},
        md: {fontSize: sizeToCircleContainer.md.fontSize, lineHeight: sizeToCircleContainer.md.lineHeight},
        lg: {fontSize: sizeToCircleContainer.lg.fontSize, lineHeight: sizeToCircleContainer.lg.lineHeight},
        xl: {fontSize: sizeToCircleContainer.xl.fontSize, lineHeight: sizeToCircleContainer.xl.lineHeight},
      },
    },
  },
}))
