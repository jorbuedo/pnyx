/**
 * "N transactions queued" banner for the Send funnel.
 *
 * The queue is only layered into the Send build, not into `rail.spendableUtxos`,
 * so wallet balances elsewhere still show the funds a queued leg has committed.
 * This banner is what stops that from being a lie: the commitment is visible
 * wherever the user could act on it, with a way out.
 *
 * @module
 */

import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {ChamferBackground} from '../../../components/Chamfer'
import {Typography} from '../../../components/Typography'
import {useI18n} from '../../../providers'
import {useSendFlow} from './SendFlowProvider'

export const QueuedLegsBanner = () => {
  const {t} = useI18n()
  const {queuedLegs, discardQueuedLeg} = useSendFlow()
  const last = queuedLegs[queuedLegs.length - 1]
  if (last === undefined) return null

  return (
    <View style={styles.root} testID="send-queue-banner">
      <ChamferBackground size="auto" fillToken="backgroundAlternative" />
      <Typography variant="bodySm_medium" style={styles.label}>
        {t('cardanoSend.queue.banner', {count: queuedLegs.length})}
      </Typography>
      <Pressable
        onPress={() => void discardQueuedLeg(last.legId)}
        accessibilityRole="button"
        accessibilityLabel={t('cardanoSend.queue.discard')}
        testID="send-queue-discard"
      >
        <Typography variant="bodySm_medium" style={styles.action}>
          {t('cardanoSend.queue.discard')}
        </Typography>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create(({spacing, colors}) => ({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.spacing8,
    padding: spacing.spacing12,
  },
  label: {color: colors.textDefault},
  action: {color: colors.primaryDefault},
}))
