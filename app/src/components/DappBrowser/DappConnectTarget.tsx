/**
 * Which wallet group + account a dApp connection will expose, with an inline
 * switcher. The grant is scoped to exactly this pair, so the sheet has to name it
 * — and picking a different one changes the app's active selection, because the
 * connection serves whatever the active account holds. See
 * `docs/CONNECTED_DAPPS.md`.
 *
 * ⚠️ **The list has no height of its own, and must not grow one.** It used to be a
 * `maxHeight: 220` box with nothing to scroll it, so a wallet past the third row was
 * unreachable — the rows rendered straight over the duration picker and the footer.
 * The sheet's own `scrollable` content area is the one scroller; a clamp here would
 * put a second, unscrollable one inside it.
 *
 * @module
 */

import {CARDANO_MAINNET} from '@pnyx/config'
import {useState} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useI18n, useWalletList} from '../../providers'
import {accountIdenticonSeed} from '../../utils/account-display'
import {Accordion} from '../Accordion'
import {ChamferBackground} from '../Chamfer'
import {Typography} from '../Typography'
import {WalletIdenticon} from '../WalletIdenticon'

const styles = StyleSheet.create(({colors, spacing}) => ({
  container: {paddingTop: spacing.spacing8},
  picker: {gap: spacing.spacing8, paddingTop: spacing.spacing8},
  groupLabel: {
    color: colors.textMuted,
    paddingHorizontal: spacing.spacing4,
    paddingTop: spacing.spacing4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.spacing12,
    padding: spacing.spacing12,
  },
  rowName: {flex: 1},
}))

export type DappConnectTargetProps = {
  /** The group the grant will be scoped to, or null when no wallet is selected. */
  readonly groupId: string | null
  readonly accountIndex: number
}

/**
 * Renders the active group + account and, when expanded, every group with its
 * derived accounts. Selecting one makes it active.
 *
 * The chooser is the same accordion-of-wallet-rows the link sheet uses, and the rows
 * carry the identicon of the account they select — a wallet should look like itself
 * wherever it is picked, and an account is only distinguishable by that identicon.
 */
export const DappConnectTarget = ({groupId, accountIndex}: DappConnectTargetProps) => {
  const {t} = useI18n()
  const {walletGroups, selectAccount, selectWallet} = useWalletList()
  const [expanded, setExpanded] = useState(false)

  const group = walletGroups.find((g) => g.groupId === groupId) ?? null
  const summary =
    group === null
      ? t('txReview.dapp.targetNoWallet')
      : `${group.name} · ${t('manageAccounts.accountLabel', {index: accountIndex})}`

  const choose = async (nextGroupId: string, nextAccountIndex: number) => {
    setExpanded(false)
    // selectAccount operates on the active selection, so the group goes first.
    if (nextGroupId !== groupId) await selectWallet(nextGroupId)
    await selectAccount(CARDANO_MAINNET, nextAccountIndex)
  }

  return (
    <View style={styles.container}>
      <Accordion
        title={t('txReview.dapp.targetTitle')}
        description={summary}
        spacing="compact"
        isExpanded={expanded}
        onExpandedChange={setExpanded}
        leftContent={
          group === null ? undefined : (
            <WalletIdenticon
              seed={accountIdenticonSeed(group.primaryWallet.checksum?.seed ?? group.groupId, accountIndex)}
              iconStyle="blockies"
              size={32}
            />
          )
        }
        testID="dapp-connect-target"
      >
        <View style={styles.picker}>
          {walletGroups.map((candidate) => {
            const accounts = candidate.primaryWallet.accounts ?? []
            // A group with no derived account list still offers its account 0.
            const indices = accounts.length > 0 ? accounts.map((a) => a.index) : [0]
            const baseSeed = candidate.primaryWallet.checksum?.seed ?? candidate.groupId
            return (
              <View key={candidate.groupId}>
                <Typography variant="bodySm_medium" style={styles.groupLabel}>
                  {candidate.name}
                </Typography>
                {indices.map((index) => {
                  const isActive = candidate.groupId === groupId && index === accountIndex
                  return (
                    <Pressable
                      key={`${candidate.groupId}-${index}`}
                      onPress={() => void choose(candidate.groupId, index)}
                      accessibilityRole="radio"
                      accessibilityState={{selected: isActive}}
                      accessibilityLabel={`${candidate.name} · ${t('manageAccounts.accountLabel', {index})}`}
                      style={styles.row}
                      testID={`dapp-connect-target-${candidate.groupId}-${index}`}
                    >
                      <ChamferBackground
                        size="auto"
                        fillToken={isActive ? 'accentMuted' : 'backgroundAlternative'}
                        borderToken={isActive ? 'primaryDefault' : 'borderDefaultWeak'}
                        borderWidth={1}
                      />
                      <WalletIdenticon seed={accountIdenticonSeed(baseSeed, index)} iconStyle="blockies" size={32} />
                      <View style={styles.rowName}>
                        <Typography variant="bodyMd_medium" numberOfLines={1}>
                          {t('manageAccounts.accountLabel', {index})}
                        </Typography>
                      </View>
                    </Pressable>
                  )
                })}
              </View>
            )
          })}
        </View>
      </Accordion>
    </View>
  )
}
