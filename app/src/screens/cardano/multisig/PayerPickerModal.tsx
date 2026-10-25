/**
 * Pick the wallet that pays for a shared wallet's on-chain registration.
 *
 * A shared wallet holds nothing when it is created, so somebody else's wallet has
 * to fund the transaction — and the only route to this screen is the shared
 * wallet's own management screen, which means the shared wallet is the *active*
 * one. Telling the user to go and switch wallets was a dead end: coming back
 * requires selecting the shared wallet again, which un-selects the payer.
 *
 * So the payer is chosen here. Picking one makes it the active wallet, because
 * that is what the rail and the review funnel are built around — and it is
 * honest: the transaction is that wallet's, and its name is what the review
 * screen shows above the fee.
 *
 * @module
 */

import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Modal} from '../../../components/Modal'
import {Typography} from '../../../components/Typography'
import {WalletGroupCard} from '../../../components/WalletGroupCard'
import {useI18n, useWalletList} from '../../../providers'
import {spendCapability} from '../../../services/cardano/link-action-wallets'

const styles = StyleSheet.create(({spacing, colors}) => ({
  list: {gap: spacing.spacing8},
  muted: {color: colors.textMuted},
  empty: {padding: spacing.spacing24, alignItems: 'center'},
  note: {color: colors.textMuted, paddingTop: spacing.spacing12},
}))

export type PayerPickerModalProps = {
  readonly visible: boolean
  readonly onClose: () => void
  readonly onPicked: (groupId: string) => void
}

export const PayerPickerModal = ({visible, onClose, onPicked}: PayerPickerModalProps) => {
  const {t} = useI18n()
  const {walletGroups} = useWalletList()

  // A wallet that signs alone. Watch-only cannot pay for anything, and another
  // shared wallet would need its own quorum to fund this one's registration —
  // reusing `spendCapability` rather than re-deciding what "can pay" means.
  const payers = walletGroups.filter((group) => spendCapability(group.primaryWallet?.source) === 'signs-alone')
  const hidden = walletGroups.length - payers.length

  return (
    <Modal
      visible={visible}
      onClose={onClose}
      position="bottom"
      scrollable
      title={t('multisig.payer.title')}
      testID="multisig-payer-picker"
    >
      <Typography variant="bodySm_regular" style={styles.muted}>
        {t('multisig.payer.body')}
      </Typography>

      {payers.length === 0 ? (
        <View style={styles.empty}>
          <Typography variant="bodyMd_regular" style={styles.muted}>
            {t('multisig.payer.none')}
          </Typography>
        </View>
      ) : (
        <View style={styles.list}>
          {payers.map((group) => (
            <WalletGroupCard
              key={group.groupId}
              group={group}
              isActive={false}
              onPress={() => onPicked(group.groupId)}
              testID={`multisig-payer-${group.groupId}`}
            />
          ))}
        </View>
      )}

      {/* Counted rather than silently dropped, for the same reason the co-signer
          picker counts what it hides: a list of "your wallets" missing one leaves
          the reader wondering which and why. */}
      {hidden > 0 ? (
        <Typography variant="bodyXs_regular" style={styles.note}>
          {t('multisig.payer.hidden', {count: hidden})}
        </Typography>
      ) : null}
    </Modal>
  )
}
