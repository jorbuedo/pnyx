/**
 * ShowcaseItem component.
 *
 * A wrapper for individual component showcases with optional label.
 *
 * @module
 */

import type {ReactNode} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Typography} from '../../components/Typography'
import {ShowcaseBoundary} from './ShowcaseBoundary'

export type ShowcaseItemProps = {
  /** Item label */
  label?: string
  /** Whether to display inline (row) vs stacked (column) */
  inline?: boolean
  /** Item content */
  children: ReactNode
}

/**
 * Wrapper for individual component showcase.
 *
 * The content is error-boundaried: a component that cannot render standalone
 * (missing screen context, unmocked native module) shows as a labelled failure
 * instead of blanking the whole category.
 */
export const ShowcaseItem = ({label, inline = false, children}: ShowcaseItemProps) => {
  return (
    <View style={[styles.container, inline && styles.inline]}>
      {label && (
        <Typography variant="bodyXs_medium" style={styles.label}>
          {label}
        </Typography>
      )}
      <View style={[styles.content, inline && styles.inlineContent]}>
        <ShowcaseBoundary name={label ?? 'component'}>{children}</ShowcaseBoundary>
      </View>
    </View>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  container: {
    gap: spacing.spacing8,
  },
  inline: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  label: {
    color: colors.textAlternative,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  content: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.spacing8,
    alignItems: 'center',
  },
  inlineContent: {
    marginBottom: 0,
  },
}))
