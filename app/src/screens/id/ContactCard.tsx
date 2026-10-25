/**
 * The contact card, summarised on the ID tab.
 *
 * Read-only here on purpose: editing lives on its own screen
 * ({@link module:./ContactCardScreen}). It was a bottom sheet first, and several live inputs inside one
 * did not perform (dev-lead call, 2026-08-26) — a sheet that grows for the keyboard while holding a
 * scrolling list of text fields is the shape React Native handles worst.
 *
 * Laid out as a `SectionHeader` + `Card`, with `Edit` as the header's trailing link — the same shape the
 * assets and activity widgets use on the Wallets home, so a third widget on a third tab does not invent
 * a fourth way of saying "see more".
 *
 * ⚠️ The public-data warning lives on the **editor**, not here. It is a warning about writing, and this
 * surface only reads.
 *
 * @module
 */

import type {CardEntry} from '@pnyx/contract-client/card'
import {useRouter} from 'expo-router'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Card} from '../../components/Card'
import {SectionHeader} from '../../components/SectionHeader'
import {Typography} from '../../components/Typography'
import {useI18n} from '../../providers'
import {cardEntryKey} from './card-kind-label'

type Props = {
  /** `undefined` while the card is still being read — not the same as a card with nothing on it. */
  readonly entries: readonly CardEntry[] | undefined
  readonly busy: boolean
}

export function ContactCard({entries, busy}: Props) {
  const {t} = useI18n()
  const router = useRouter()

  return (
    <View style={styles.section} testID="id-contact-card">
      <SectionHeader
        title={t('you.card.title')}
        // Withheld until the read lands: the editor cannot offer a Save against a card it never saw, so
        // opening it early would show a blank card that a save would then write.
        link={
          entries === undefined || busy
            ? undefined
            : {label: t('you.card.edit'), onPress: () => router.push('/id/card'), testID: 'id-card-edit'}
        }
      />
      {/* The empty state keeps the card and centres one muted line, the same shape the activity widget
          on the Wallets home uses. A widget that vanishes when it has nothing reads as a widget that
          failed to load. */}
      <Card style={entries !== undefined && entries.length === 0 ? styles.emptyCard : styles.card}>
        {entries === undefined ? null : entries.length === 0 ? (
          <Typography variant="bodySm_regular" style={styles.emptyText}>
            {t('you.card.empty')}
          </Typography>
        ) : (
          <View style={styles.list}>
            {entries.map((entry, index) => (
              <View key={`${entry.kind}-${index}`} style={styles.row} testID={`id-card-summary-${index}`}>
                <Typography variant="bodyXs_regular" style={styles.muted}>
                  {t(cardEntryKey(entry.kind, entry.value))}
                </Typography>
                <Typography variant="bodySm_regular" numberOfLines={1} style={styles.value}>
                  {entry.value}
                </Typography>
              </View>
            ))}
          </View>
        )}
      </Card>
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  // No gap: the header's chamfered band reads as the card's own lip, and a gap detaches it.
  section: {width: '100%'},
  card: {width: '100%', padding: theme.spacing.spacing16},
  emptyCard: {width: '100%', minHeight: 132, alignItems: 'center', justifyContent: 'center'},
  list: {gap: theme.spacing.spacing8},
  row: {gap: theme.spacing.spacing4},
  value: {color: theme.colors.textDefault},
  muted: {color: theme.colors.textAlternative},
  // Centred like the line it replaced, which the card has always centred — but it is a sentence now
  // and wraps, so the alignment has to be said rather than inherited from a single line's position.
  emptyText: {color: theme.colors.textAlternative, textAlign: 'center'},
}))
