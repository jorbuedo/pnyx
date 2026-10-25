/**
 * SettingsSection component.
 *
 * A section container for grouping related settings rows with a title.
 *
 * @module
 */

import type {ReactElement, ReactNode} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Card} from './Card'
import {Typography} from './Typography'

export type SettingsSectionProps = {
  /** Section title */
  title: string
  /** Section content (typically SettingsRow components) */
  children: ReactNode
  /**
   * Glass effect — semi-transparent background (`backgroundLayer1`) with
   * 16px radius and overflow hidden.
   */
  /** Test ID for e2e testing */
  testID?: string | undefined
}

/**
 * SettingsSection component.
 *
 * Groups related settings rows within a card with a section title.
 *
 * @example
 * ```tsx
 * <SettingsSection title="Appearance">
 *   <SettingsRow label="Theme">
 *     <Button label="Light" variant="secondary" size="sm" />
 *   </SettingsRow>
 *   <SettingsRow label="Dark Mode">
 *     <Toggle checked={isDark} onChange={setIsDark} />
 *   </SettingsRow>
 * </SettingsSection>
 * ```
 */
export const SettingsSection = ({title, children, testID}: SettingsSectionProps): ReactElement => {
  return (
    <Card style={styles.card} testID={testID}>
      <Typography variant="bodyMd_medium" style={styles.title}>
        {title}
      </Typography>
      <View style={styles.content}>{children}</View>
    </Card>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  card: {
    paddingVertical: spacing.spacing16,
    gap: spacing.spacing12,
  },
  title: {
    color: colors.textDefault,
    paddingHorizontal: spacing.spacing16,
  },
  content: {
    gap: spacing.spacing4,
  },
}))
