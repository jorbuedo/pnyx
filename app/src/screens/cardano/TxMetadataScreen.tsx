/**
 * One metadata label, in full.
 *
 * Details collapses every label to a few lines because most of them are short. The
 * ones that are not are very long — a financial-records payload pretty-prints to
 * nearly a thousand lines — and expanding that in place mounted a Text per line
 * inside a chamfered `Card`, whose paint layer is a single SVG bitmap the size of
 * the card. At ~58,000px tall that bitmap is 231MB, over Android's canvas cap, and
 * the process is killed outright rather than throwing into an error boundary.
 *
 * So the full payload is a screen with a virtualized list and no painted surface
 * around it: the rendered height is the viewport whatever the payload does.
 *
 * The lines arrive through `metadata-handoff` rather than the route, because a
 * transaction being reviewed before signing has no hash to fetch them back by.
 *
 * @module
 */

import {useLocalSearchParams} from 'expo-router'
import {useEffect} from 'react'
import {FlatList} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {Typography} from '../../components/Typography'
import {logger} from '../../logger'
import {useI18n} from '../../providers'
import {readPendingMetadata} from './review/metadata-handoff'

const styles = StyleSheet.create(({spacing, colors}) => ({
  list: {paddingHorizontal: spacing.spacing16, paddingBottom: spacing.spacing16, gap: spacing.spacing2},
  heading: {color: colors.textAlternative, paddingVertical: spacing.spacing12},
  line: {color: colors.textDefault},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.spacing24},
  muted: {color: colors.textAlternative},
}))

export const TxMetadataScreen = () => {
  const {t} = useI18n()
  const {label} = useLocalSearchParams<{label: string}>()
  const entry = label === undefined ? undefined : readPendingMetadata(label)

  useEffect(() => {
    // Reachable by navigating here without the block that parks the payload — a
    // reload while the screen is open drops it. Silence would render as an empty
    // metadata screen with nothing to say why.
    if (entry === undefined) logger.warn('No metadata parked for this label', {origin: 'TxMetadataScreen', label})
  }, [entry, label])

  if (entry === undefined) {
    return (
      <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.center}>
        <Typography variant="bodyMd_regular" style={styles.muted}>
          {t('txReview.details.metadataUnavailable')}
        </Typography>
      </SafeAreaViewWrapper>
    )
  }

  return (
    <SafeAreaViewWrapper edges={['bottom']}>
      <FlatList
        data={entry.lines}
        keyExtractor={(_line, i) => String(i)}
        renderItem={({item}) => (
          <Typography variant="bodySm_regular" style={styles.line}>
            {item}
          </Typography>
        )}
        ListHeaderComponent={
          <Typography variant="bodySm_regular" style={styles.heading}>
            {entry.heading}
          </Typography>
        }
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        testID="tx-metadata-lines"
      />
    </SafeAreaViewWrapper>
  )
}
