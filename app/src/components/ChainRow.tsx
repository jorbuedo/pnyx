/**
 * A single chain row: branded network icon + name (+ optional subtitle) with a
 * flexible right slot and an optional body below. Shared by the Wallets-tab
 * asset list (subtitle = balance/ticker, right = chevron, whole row pressable)
 * and the Receive screen (right = QR action, body = copiable address).
 *
 * @module
 */

import type {ChainId} from '@pnyx/config'
import type {ReactNode} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Card} from './Card'
import {NetworkIcon} from './NetworkIcon'
import {Typography} from './Typography'

export type ChainRowProps = {
  readonly chain: ChainId
  readonly name: string
  readonly subtitle?: string
  /** Custom node in the subtitle position (e.g. a copiable `Address`); wins over `subtitle`. */
  readonly subtitleContent?: ReactNode
  readonly onPress?: () => void
  readonly right?: ReactNode
  /** Align the right slot with the name line instead of centering it on the row. */
  readonly rightAlignTop?: boolean
  readonly children?: ReactNode
  readonly testID?: string
}

export const ChainRow = ({
  chain,
  name,
  subtitle,
  subtitleContent,
  onPress,
  right,
  rightAlignTop = false,
  children,
  testID,
}: ChainRowProps) => (
  <Card variant="outlined" style={styles.card} testID={testID} {...(onPress !== undefined && {onPress})}>
    <View style={styles.header}>
      <View style={styles.left}>
        <NetworkIcon chain={chain} size={36} />
        <View style={styles.labels}>
          {/* With rightAlignTop the right slot joins the name line, so the
              subtitle line below gets the full remaining card width. */}
          {right !== undefined && rightAlignTop ? (
            <View style={styles.nameRow}>
              <Typography variant="bodyMd_medium">{name}</Typography>
              {right}
            </View>
          ) : (
            <Typography variant="bodyMd_medium">{name}</Typography>
          )}
          {subtitleContent !== undefined ? (
            subtitleContent
          ) : subtitle !== undefined ? (
            <Typography variant="bodySm_regular" style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Typography>
          ) : null}
        </View>
      </View>
      {right !== undefined && !rightAlignTop && <View style={styles.right}>{right}</View>}
    </View>
    {children}
  </Card>
)

const styles = StyleSheet.create((theme) => ({
  card: {
    padding: theme.spacing.spacing12,
    gap: theme.spacing.spacing12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.spacing8,
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing12,
    // Take the leftover width (not just shrink) so flexible subtitle content
    // (e.g. the copiable Address) has a real width to truncate against.
    flex: 1,
  },
  labels: {
    gap: theme.spacing.spacing2,
    flex: 1,
  },
  subtitle: {
    color: theme.colors.textMuted,
  },
  right: {
    flexShrink: 0,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.spacing8,
  },
}))
