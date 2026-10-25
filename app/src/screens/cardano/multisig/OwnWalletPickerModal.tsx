/**
 * Pick one of this device's own wallets as a co-signer.
 *
 * Only wallets that can actually contribute a key are listed. The picker used to
 * show every wallet with a reason beside the ones that could not — which read as a
 * list of things to try, most of which were refusals. A watch-only wallet holds no
 * signing key and a shared wallet is spent by its own policy, and neither will ever
 * be a co-signer, so neither belongs in a chooser.
 *
 * What is hidden is still counted, in one line under the list. Silently dropping
 * wallets from a list of "your wallets" would leave a reader wondering which one is
 * missing and why.
 *
 * Rows are the same card the wallet list and the switcher use, identicon and all —
 * a wallet should look like itself wherever it is picked.
 *
 * @module
 */

import type {WalletSource} from '@pnyx/wallet'
import {Either} from 'effect'
import {useMemo, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Modal} from '../../../components/Modal'
import {Typography} from '../../../components/Typography'
import {WalletGroupCard} from '../../../components/WalletGroupCard'
import {useLocalCoSignerKeys} from '../../../hooks/useLocalCoSigners'
import {useI18n, useWalletList} from '../../../providers'
import {coSignerFailureKey, coSignerKeyAccessOf, coSignerKeyIsReady} from '../../../services/cardano/multisig'
import {resolveGroupCoSignerXpub} from '../../../services/group-seed'

const styles = StyleSheet.create(({spacing, colors}) => ({
  list: {gap: spacing.spacing8},
  muted: {color: colors.textMuted},
  note: {color: colors.textMuted, paddingTop: spacing.spacing12},
  empty: {padding: spacing.spacing24, alignItems: 'center'},
}))

export type OwnWalletPickerModalProps = {
  readonly visible: boolean
  readonly onClose: () => void
  /**
   * `groupId` rides along because a caller may need to keep talking about the *wallet* after the
   * pick (its key access, its display name), not just the key that came out of it.
   */
  readonly onPicked: (picked: {
    readonly groupId: string
    readonly name: string
    readonly accountXpubHex: string
  }) => void
  /** Xpubs already in the roster, so a wallet cannot be added twice. */
  readonly takenXpubs: readonly string[]
}

const ACCOUNT_INDEX = 0

export const OwnWalletPickerModal = ({visible, onClose, onPicked, takenXpubs}: OwnWalletPickerModalProps) => {
  const {t} = useI18n()
  const {walletGroups} = useWalletList()
  const localKeys = useLocalCoSignerKeys()
  const [derivingId, setDerivingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const taken = new Set(takenXpubs.map((x) => x.toLowerCase()))

  // Listed only if the key can be produced without leaving this sheet: from the
  // seed, or from a hardware wallet's cache. A hardware wallet whose key has
  // never been read stays out — the fix for it is a device connection, which is
  // a navigation, and offering it here would be a tap that fails.
  const eligible = useMemo(
    () =>
      walletGroups.filter((group) => {
        const source = group.primaryWallet?.source
        if (source === undefined) return false
        const cached = localKeys.find((k) => k.groupId === group.groupId)?.govKeys?.sharedAccountXpubHex !== undefined
        return coSignerKeyIsReady(coSignerKeyAccessOf(source, cached))
      }),
    [walletGroups, localKeys],
  )
  const hidden = walletGroups.length - eligible.length

  const pick = async (groupId: string, source: WalletSource, name: string) => {
    if (derivingId !== null) return
    setDerivingId(groupId)
    setError(null)
    try {
      const result = await resolveGroupCoSignerXpub(groupId, source, t('common.biometricPrompt'), ACCOUNT_INDEX)
      if (Either.isLeft(result)) {
        setError(t(coSignerFailureKey(result.left)))
        return
      }
      if (taken.has(result.right.toLowerCase())) {
        setError(t('multisig.picker.alreadyAdded'))
        return
      }
      onPicked({groupId, name, accountXpubHex: result.right})
      onClose()
    } finally {
      setDerivingId(null)
    }
  }

  return (
    <Modal
      visible={visible}
      onClose={onClose}
      position="bottom"
      scrollable
      title={t('multisig.picker.title')}
      testID="multisig-wallet-picker"
    >
      {error !== null ? (
        <Typography variant="bodySm_regular" style={styles.muted}>
          {error}
        </Typography>
      ) : null}
      {derivingId !== null ? (
        <Typography variant="bodySm_regular" style={styles.muted}>
          {t('multisig.picker.deriving')}
        </Typography>
      ) : null}

      {eligible.length === 0 ? (
        <View style={styles.empty}>
          <Typography variant="bodyMd_regular" style={styles.muted}>
            {t(hidden > 0 ? 'multisig.picker.noneEligible' : 'multisig.picker.empty')}
          </Typography>
        </View>
      ) : (
        <View style={styles.list}>
          {eligible.map((group) => (
            <WalletGroupCard
              key={group.groupId}
              group={group}
              isActive={false}
              onPress={() => {
                const source = group.primaryWallet?.source
                if (source !== undefined) void pick(group.groupId, source, group.name)
              }}
              testID={`multisig-pick-${group.groupId}`}
            />
          ))}
        </View>
      )}

      {hidden > 0 && eligible.length > 0 ? (
        <Typography variant="bodyXs_regular" style={styles.note}>
          {t('multisig.picker.hiddenCount', {count: hidden})}
        </Typography>
      ) : null}
    </Modal>
  )
}
