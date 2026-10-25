/**
 * The "Explain" affordance on the transaction-detail header, and the sheet it opens.
 *
 * Phase 14 item 38, Tier A. Deliberately scoped to **settled history**: this screen
 * and the pre-sign review screen render the same `TxReview` from the same IR, so an
 * affordance placed in that shared component would appear on the signing screen by
 * construction. A wrong summary is embarrassing about a transaction that already
 * happened and dangerous about one you are being asked to approve.
 *
 * The caller renders this only when a model is available, so there is no
 * "unavailable" state here to get wrong.
 *
 * @module
 */

import {useState} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {CircleLoader} from '../../components/Loaders'
import {Modal} from '../../components/Modal'
import {Typography} from '../../components/Typography'
import {UniIcon} from '../../components/UniIcon'
import type {ExplainSubject} from '../../hooks/useExplainTransaction'
import {useExplainTransaction} from '../../hooks/useExplainTransaction'
import {useI18n} from '../../providers'

export type ExplainTxActionProps = {
  readonly subject: ExplainSubject
}

export const ExplainTxAction = ({subject}: ExplainTxActionProps) => {
  const {t} = useI18n()
  const [open, setOpen] = useState(false)
  const {state, explain, reset} = useExplainTransaction(subject)

  const onPress = () => {
    setOpen(true)
    explain()
  }

  const onClose = () => {
    setOpen(false)
    // Dropped rather than cached: the facts can change as a pending transaction
    // settles, and a stale explanation of a since-changed transaction is exactly the
    // kind of confidently-wrong output this feature has to avoid.
    reset()
  }

  return (
    <>
      <Pressable
        onPress={onPress}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel={t('explainTx.action')}
        testID="tx-detail-explain"
      >
        <UniIcon name="lightbulb" size="md" uniProps={(theme) => ({color: theme.colors.primaryDefault})} />
      </Pressable>

      <Modal
        visible={open}
        onClose={onClose}
        position="bottom"
        // Past tense is wrong on the pre-sign sheet: nothing has happened yet.
        title={t(subject.when === 'pending' ? 'explainTx.titlePending' : 'explainTx.title')}
        testID="tx-detail-explain-sheet"
      >
        <View style={styles.body}>
          {state.status === 'running' ? (
            <View style={styles.centered}>
              <CircleLoader size="md" />
              <Typography variant="bodySm_regular" style={styles.muted}>
                {t('explainTx.running')}
              </Typography>
            </View>
          ) : null}

          {state.status === 'ready' ? (
            <Typography variant="bodyMd_regular" testID="tx-detail-explain-text">
              {state.text}
            </Typography>
          ) : null}

          {state.status === 'failed' ? (
            <Typography variant="bodyMd_regular" testID="tx-detail-explain-error">
              {t('explainTx.failed')}
            </Typography>
          ) : null}

          {/* Always shown, including while running — the label is about the source of
              the text, not about how confident this particular answer is. */}
          <Typography variant="bodyXs_regular" style={styles.muted}>
            {t('explainTx.disclaimer')}
          </Typography>
        </View>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  body: {
    gap: spacing.spacing12,
  },
  centered: {
    alignItems: 'center',
    gap: spacing.spacing8,
  },
  muted: {
    color: colors.textMuted,
  },
}))
