import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useWalletStatusLabel} from '../hooks/useWalletStatusLabel'
import type {WalletGroupView} from '../providers'
import {accountIdenticonSeed} from '../utils/account-display'
import {Card} from './Card'
import {Typography} from './Typography'
import {UniIcon} from './UniIcon'
import {WalletIdenticon} from './WalletIdenticon'

type Props = {
  group: WalletGroupView
  isActive: boolean
  onPress?: (() => void) | undefined
  testID?: string | undefined
}

export function WalletGroupCard({group, isActive, onPress, testID}: Props) {
  const {label: statusLabel, isWarning} = useWalletStatusLabel(group)
  const resolvedTestID = testID ?? `wallet-group-${isActive ? 'active' : 'inactive'}-${group.primaryWallet.name}`
  const baseSeed = group.primaryWallet.checksum?.seed ?? group.groupId
  const content = (
    <Card variant={isActive ? 'selected' : 'filled'} style={styles.card}>
      <WalletIdenticon seed={accountIdenticonSeed(baseSeed, 0)} iconStyle="blockies" size={36} />
      <View style={styles.info}>
        <View style={styles.name}>
          <Typography variant="bodyLg_medium" numberOfLines={1}>
            {group.name}
          </Typography>
        </View>
        {statusLabel ? (
          <Typography
            variant="bodySm_regular"
            style={[styles.status, isWarning ? styles.statusWarn : styles.statusOk]}
            numberOfLines={1}
          >
            · {statusLabel}
          </Typography>
        ) : null}
      </View>
      {onPress ? (
        <UniIcon
          name="rightThin"
          width={12}
          height={12}
          uniProps={(theme) => ({color: theme.colors.textMuted})}
          testID={`wallet-group-more-${group.primaryWallet.name}`}
        />
      ) : null}
    </Card>
  )

  return (
    <>
      {onPress ? (
        <Pressable onPress={onPress} style={({pressed}) => pressed && styles.pressed} testID={resolvedTestID}>
          {content}
        </Pressable>
      ) : (
        <View testID={resolvedTestID}>{content}</View>
      )}
    </>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  // Layout only. The surface, the corner and the selected edge all belong to Card —
  // an inactive card is the plain flat surface every other card is, so selection is
  // the only thing an edge means.
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.spacing12,
    paddingVertical: spacing.spacing16,
    paddingHorizontal: spacing.spacing16,
  },
  pressed: {
    opacity: 0.85,
    transform: [{scale: 0.985}],
  },
  info: {
    gap: spacing.spacing4,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    flex: 1,
  },
  name: {
    flexShrink: 1,
    minWidth: 0,
  },
  status: {
    flexShrink: 0,
  },
  statusOk: {
    color: colors.textAlternative,
  },
  statusWarn: {
    color: colors.errorDefault,
    fontWeight: '600',
  },
}))
