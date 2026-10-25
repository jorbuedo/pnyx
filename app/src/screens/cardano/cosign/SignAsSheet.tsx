/**
 * Pick which co-signer's signature to give.
 *
 * A shared wallet holds no key: every signature comes from one of the co-signer
 * wallets on this device, and the same button produces a different person's
 * depending on which. That choice used to be made silently by whichever wallet
 * happened to be selected in the app; this is where it is made out loud, at the
 * moment of signing rather than as a setting to notice beforehand.
 *
 * Counts, not ticks, for anyone still owed: a co-signer contributes one witness
 * per script — the spend and the delegation — so "signed" would be wrong for
 * someone who has given one and not the other. The check appears only when they
 * owe nothing more.
 *
 * @module
 */

import {FlatList, Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Modal} from '../../../components/Modal'
import {Typography} from '../../../components/Typography'
import {UniIcon} from '../../../components/UniIcon'
import {useI18n} from '../../../providers'
import type {LocalCoSigner} from '../../../services/cardano/multisig/local-cosigners'

const styles = StyleSheet.create(({spacing, colors}) => ({
  row: {flexDirection: 'row', alignItems: 'center', gap: spacing.spacing12, paddingVertical: spacing.spacing12},
  rowText: {flex: 1, gap: spacing.spacing2},
  muted: {color: colors.textMuted},
  pending: {color: colors.textAlternative},
  separator: {height: 1, backgroundColor: colors.borderDefaultWeak},
}))

export type SignAsSheetProps = {
  readonly visible: boolean
  readonly onClose: () => void
  readonly coSigners: readonly LocalCoSigner[]
  readonly onPick: (coSigner: LocalCoSigner) => void
}

export const SignAsSheet = ({visible, onClose, coSigners, onPick}: SignAsSheetProps) => {
  const {t} = useI18n()

  return (
    <Modal
      visible={visible}
      onClose={onClose}
      position="bottom"
      title={t('cosign.signAsLabel')}
      testID="cosign-sign-as"
    >
      <FlatList
        data={coSigners}
        keyExtractor={(c) => c.tag}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        renderItem={({item}) => {
          const complete = item.required > 0 && item.signed >= item.required
          return (
            <Pressable
              disabled={complete}
              onPress={() => {
                onPick(item)
                onClose()
              }}
              style={styles.row}
              accessibilityRole="button"
              accessibilityState={{disabled: complete}}
              testID={`cosign-sign-as-${item.tag}`}
            >
              <View style={styles.rowText}>
                <Typography variant="bodyMd_medium">{item.coSignerName}</Typography>
                {/* The wallet whose seed actually produces the signature, which
                    need not share the roster's name for the same person. */}
                {item.walletName !== item.coSignerName && (
                  <Typography variant="bodySm_regular" style={styles.muted}>
                    {item.walletName}
                  </Typography>
                )}
              </View>
              {complete ? (
                <UniIcon name="check" size="sm" uniProps={(theme) => ({color: theme.colors.successDefault})} />
              ) : (
                <Typography variant="bodySm_regular" style={styles.pending}>
                  {t('txReview.signatures.rOfT', {signed: item.signed, required: item.required})}
                </Typography>
              )}
            </Pressable>
          )
        }}
      />
    </Modal>
  )
}
