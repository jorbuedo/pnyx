import {router, useLocalSearchParams} from 'expo-router'
import {useCallback, useState} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../src/components/Buttons'
import {ChamferBackground} from '../../src/components/Chamfer'
import {Checkbox} from '../../src/components/Checkbox'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {StickyFooter} from '../../src/components/StickyFooter'
import {Typography} from '../../src/components/Typography'
import {UniIcon} from '../../src/components/UniIcon'
import {useI18n, useWalletList} from '../../src/providers'

type CheckKey = 'alone' | 'share' | 'loss' | 'offline'

const CHECK_KEYS: CheckKey[] = ['alone', 'share', 'loss', 'offline']

export default function RecoveryPhraseWarnScreen() {
  const {
    groupId,
    showOnly,
    identity: identityParam,
  } = useLocalSearchParams<{groupId?: string; showOnly?: string; identity?: string}>()
  const isIdentity = identityParam === 'true'
  const {t} = useI18n()
  const {walletGroups, selectedWalletGroup} = useWalletList()

  const targetGroupId = isIdentity ? undefined : groupId || selectedWalletGroup?.groupId
  const walletName = isIdentity
    ? t('settings.backup.warn.thisWallet')
    : (walletGroups.find((g) => g.groupId === targetGroupId)?.name ?? '').trim() || t('settings.backup.warn.thisWallet')

  const [checked, setChecked] = useState<Record<CheckKey, boolean>>({
    alone: false,
    share: false,
    loss: false,
    offline: false,
  })

  const allChecked = CHECK_KEYS.every((k) => checked[k])

  const toggle = useCallback((key: CheckKey) => {
    setChecked((prev) => ({...prev, [key]: !prev[key]}))
  }, [])

  const handleReveal = useCallback(() => {
    const params: Record<string, string> = isIdentity
      ? {identity: 'true'}
      : targetGroupId
        ? {groupId: targetGroupId}
        : {}
    if (showOnly === 'true') params.showOnly = 'true'
    router.replace({pathname: '/settings/backup-verification', params})
  }, [isIdentity, targetGroupId, showOnly])

  return (
    <SafeAreaViewWrapper
      edges={['bottom']}
      scrollable
      stickyFooter={
        <StickyFooter>
          <Button
            label={t('settings.backup.warn.revealButton')}
            onPress={handleReveal}
            isDisabled={!allChecked}
            fullWidth
            size="xl"
            testID="settings-backup-warn-revealButton"
          />
        </StickyFooter>
      }
    >
      <View style={styles.hero}>
        <View style={styles.iconMark}>
          <ChamferBackground size="auto" fillToken="errorMuted" borderToken="errorBorder" borderWidth={1} />
          <UniIcon name="warning" size="lg" uniProps={(theme) => ({color: theme.colors.errorDefault})} />
        </View>
        <Typography variant="headingMd" style={styles.title}>
          {t('settings.backup.warn.title')}
        </Typography>
        <Typography variant="bodyMd_regular" style={styles.subtitle}>
          {t('settings.backup.warn.subtitlePart1')}
          <Typography variant="bodyMd_medium" style={styles.subtitleAccess}>
            {t('settings.backup.warn.subtitleBoldAccess')}
          </Typography>
          {t('settings.backup.warn.subtitlePart2')}
          <Typography variant="bodyMd_medium" style={styles.subtitleWallet}>
            {walletName}
          </Typography>
          {t('settings.backup.warn.subtitleSuffix')}
        </Typography>
      </View>

      <View style={styles.checks}>
        {CHECK_KEYS.map((key) => (
          <CheckItem
            key={key}
            checked={checked[key]}
            onPress={() => toggle(key)}
            label={t(`settings.backup.warn.checks.${key}` as Parameters<typeof t>[0])}
            boldWord={key === 'offline' ? t('settings.backup.warn.checks.offlineBoldWord') : undefined}
            testID={`settings-backup-warn-checkItem-${key}`}
          />
        ))}
      </View>
    </SafeAreaViewWrapper>
  )
}

type CheckItemProps = {
  checked: boolean
  onPress: () => void
  label: string
  boldWord?: string | undefined
  testID?: string
}

function CheckItem({checked, onPress, label, boldWord, testID}: CheckItemProps) {
  styles.useVariants({checked})

  const parts = boldWord ? label.split(boldWord) : null

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{checked}}
      style={styles.checkItem}
      testID={testID}
    >
      <Checkbox checked={checked} onPress={onPress} />
      <View style={styles.checkTextContainer}>
        {parts ? (
          <Typography variant="bodySm_medium" style={styles.checkText}>
            {parts[0]}
            <Typography variant="bodySm_bold" style={styles.checkText}>
              {boldWord}
            </Typography>
            {parts[1]}
          </Typography>
        ) : (
          <Typography variant="bodySm_medium" style={styles.checkText}>
            {label}
          </Typography>
        )}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create(({spacing, borderRadius, colors}) => ({
  hero: {
    alignItems: 'center',
    paddingTop: spacing.spacing24,
    paddingHorizontal: spacing.spacing24,
    paddingBottom: spacing.spacing16,
  },
  iconMark: {
    width: 72,
    height: 72,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  title: {
    textAlign: 'center',
    letterSpacing: -0.4,
    marginBottom: spacing.spacing8,
    fontWeight: '800',
    color: colors.textDefault,
  },
  subtitle: {
    textAlign: 'center',
    maxWidth: 320,
    lineHeight: 21,
    color: colors.textAlternative,
  },
  subtitleAccess: {
    color: colors.errorDefault,
  },
  subtitleWallet: {
    color: colors.textDefault,
  },
  checks: {
    gap: 10,
    paddingHorizontal: spacing.spacing20,
    paddingBottom: spacing.spacing16,
  },
  checkItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.spacing12,
    padding: spacing.spacing12,
    borderRadius: borderRadius.rounded12,
    borderWidth: 1,
    variants: {
      checked: {
        true: {
          backgroundColor: `${colors.primaryDefault}24`,
          borderColor: colors.primaryDefault,
        },
        false: {
          backgroundColor: colors.backgroundAlternative,
          borderColor: colors.borderDefaultWeak,
        },
      },
    },
  },
  checkText: {
    color: colors.textDefault,
  },
  checkTextContainer: {
    flex: 1,
  },
}))
