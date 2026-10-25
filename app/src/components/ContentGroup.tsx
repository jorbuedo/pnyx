/**
 * ContentGroup component.
 *
 * Grouped content section with optional header and footer.
 *
 * @module
 */

import type {ReactElement, ReactNode} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {ChamferBackground} from './Chamfer'
import {Typography} from './Typography'

export type ContentGroupProps = {
  /** Group title */
  title?: string | undefined
  /** Group subtitle/description */
  subtitle?: string | undefined
  /** Group content */
  children: ReactNode
  /** Footer content */
  footer?: ReactNode | undefined
  /** Whether to show border around content */
  withBorder?: boolean | undefined
  /** Whether to add padding to content */
  withPadding?: boolean | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
}

/**
 * ContentGroup component.
 *
 * Groups related content with an optional header.
 *
 * @example
 * ```tsx
 * <ContentGroup title="Account Settings" withBorder>
 *   <NavigationButton label="Profile" />
 *   <NavigationButton label="Security" />
 *   <NavigationButton label="Preferences" />
 * </ContentGroup>
 * ```
 */
export const ContentGroup = ({
  title,
  subtitle,
  children,
  footer,
  withBorder = false,
  withPadding = false,
  testID,
}: ContentGroupProps): ReactElement => {
  return (
    <View style={styles.container} testID={testID}>
      {title || subtitle ? (
        <View style={styles.header}>
          {title ? <Typography variant="bodySm_medium">{title}</Typography> : null}
          {subtitle ? (
            <Typography variant="bodyXs_regular" style={styles.subtitle}>
              {subtitle}
            </Typography>
          ) : null}
        </View>
      ) : null}

      <View style={[styles.content, withPadding && styles.contentPadding]}>
        {withBorder && (
          <ChamferBackground
            size="auto"
            fillToken="backgroundAlternative"
            borderToken="borderDefaultWeak"
            borderWidth={1}
          />
        )}
        {children}
      </View>

      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </View>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  container: {
    gap: spacing.spacing8,
  },
  header: {
    paddingHorizontal: spacing.spacing4,
    gap: spacing.spacing2,
  },
  subtitle: {
    color: colors.textAlternative,
  },
  content: {},
  contentPadding: {
    padding: spacing.spacing16,
  },
  footer: {
    paddingHorizontal: spacing.spacing4,
  },
}))
