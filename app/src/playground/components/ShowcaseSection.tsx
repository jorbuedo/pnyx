/**
 * ShowcaseSection component.
 *
 * A section wrapper with title for grouping related component showcases.
 *
 * @module
 */

import type {ReactNode} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Typography} from '../../components/Typography'

export type ShowcaseSectionProps = {
  /** Section title */
  title: string
  /** Section description */
  description?: string
  /** Section content */
  children: ReactNode
}

/**
 * Section wrapper for grouping showcase items.
 */
export const ShowcaseSection = ({title, description, children}: ShowcaseSectionProps) => {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Typography variant="headingSm" style={styles.title}>
          {title}
        </Typography>
        {description && (
          <Typography variant="bodySm_regular" style={styles.description}>
            {description}
          </Typography>
        )}
      </View>
      <View style={styles.content}>{children}</View>
    </View>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  container: {
    gap: spacing.spacing12,
  },
  header: {
    paddingHorizontal: spacing.spacing16,
    gap: spacing.spacing4,
  },
  title: {
    color: colors.textDefault,
  },
  description: {
    color: colors.textAlternative,
  },
  content: {
    paddingHorizontal: spacing.spacing16,
    gap: spacing.spacing12,
  },
}))
