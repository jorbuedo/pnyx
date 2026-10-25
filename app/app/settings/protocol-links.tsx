import {useMemo, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../src/components/Buttons'
import {ChamferBackground} from '../../src/components/Chamfer'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {SettingsGroup} from '../../src/components/SettingsGroup'
import {SettingsRow} from '../../src/components/SettingsRow'
import {Typography} from '../../src/components/Typography'
import {UniIcon} from '../../src/components/UniIcon'
import {useToast} from '../../src/hooks/useToast'
import {logger} from '../../src/logger'
import {isExtensionSidePanel, openFullscreenRoute} from '../../src/platform'
import {useI18n} from '../../src/providers'
import {
  getPnyxProtocolHandlerAvailability,
  hasRequestedPnyxProtocolHandlerRegistration,
  PNYX_PROTOCOL_HANDLERS,
  registerPnyxProtocolHandler,
} from '../../src/services/protocol-handler-registration'

type RegistrationState = 'idle' | 'registered' | 'unsupported' | 'failed'

export default function ProtocolLinksScreen() {
  const {t} = useI18n()
  const {showToast} = useToast()
  const [registrationState, setRegistrationState] = useState<RegistrationState>(() =>
    hasRequestedPnyxProtocolHandlerRegistration() ? 'registered' : 'idle',
  )
  const availability = useMemo(() => getPnyxProtocolHandlerAvailability(), [])
  const isAvailable = availability === 'available'
  const needsFullscreenTab = availability === 'side-panel'
  const protocolHandlerSchemes = PNYX_PROTOCOL_HANDLERS.map((handler) => handler.scheme).join(', ')

  const handleEnable = async () => {
    if (needsFullscreenTab || isExtensionSidePanel) {
      try {
        await openFullscreenRoute('/settings/protocol-links')
      } catch (e: unknown) {
        logger.warn('Fullscreen route for protocol-link registration could not be opened', {
          origin: 'protocol-links',
          error: String(e),
        })
        setRegistrationState('failed')
        showToast({variant: 'error', message: t('settings.protocolLinks.openFullscreenFailedToast')})
      }
      return
    }

    const result = registerPnyxProtocolHandler()

    if (result.ok) {
      setRegistrationState('registered')
      showToast({variant: 'success', message: t('settings.protocolLinks.successToast')})
      return
    }

    if (result.reason === 'failed') {
      setRegistrationState('failed')
      showToast({variant: 'error', message: t('settings.protocolLinks.failedToast')})
      return
    }

    setRegistrationState('unsupported')
    showToast({variant: 'warning', message: t('settings.protocolLinks.unsupportedToast')})
  }

  const statusText = (() => {
    if (registrationState === 'registered') return t('settings.protocolLinks.registeredStatus')
    if (registrationState === 'failed') return t('settings.protocolLinks.failedStatus')
    if (registrationState !== 'unsupported' && isAvailable) {
      return t('settings.protocolLinks.readyStatus', {scheme: protocolHandlerSchemes})
    }
    if (availability === 'dev-iframe') return t('settings.protocolLinks.devIframeStatus')
    if (availability === 'side-panel') return t('settings.protocolLinks.sidePanelStatus')
    return t('settings.protocolLinks.unsupportedStatus')
  })()
  const enableButtonLabel = needsFullscreenTab
    ? t('settings.protocolLinks.openFullscreenButton')
    : t('settings.protocolLinks.enableButton')

  return (
    <SafeAreaViewWrapper
      style={styles.safeArea}
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.scrollContent}
    >
      <View style={styles.hero}>
        <View style={styles.iconCircle}>
          <UniIcon name="link" size="lg" uniProps={(theme) => ({color: theme.colors.primaryDefault})} />
        </View>
        <Typography variant="headingMd" style={styles.title}>
          {t('settings.protocolLinks.title')}
        </Typography>
        <Typography variant="bodyMd_regular" style={styles.description}>
          {t('settings.protocolLinks.intro', {scheme: protocolHandlerSchemes})}
        </Typography>
      </View>

      <SettingsGroup label={t('settings.protocolLinks.sectionLabel')}>
        <SettingsRow
          label={t('settings.protocolLinks.schemeLabel')}
          description={protocolHandlerSchemes}
          leftIcon="link"
          iconColor="textMuted"
          showBorder
        />
        <SettingsRow
          label={t('settings.protocolLinks.destinationLabel')}
          description={t('settings.protocolLinks.destinationDescription')}
          leftIcon="qr"
          iconColor="textMuted"
        />
      </SettingsGroup>

      <View style={styles.statusCard}>
        <ChamferBackground size="auto" fillToken="backgroundAlternative" borderToken="borderDefaultWeak" />
        <Typography variant="bodySm_medium" style={styles.statusLabel}>
          {t('settings.protocolLinks.statusLabel')}
        </Typography>
        <Typography variant="bodyMd_regular" style={styles.statusText}>
          {statusText}
        </Typography>
      </View>

      <Button
        label={enableButtonLabel}
        variant="primary"
        size="xl"
        fullWidth
        isDisabled={!isAvailable && !needsFullscreenTab}
        onPress={handleEnable}
        testID="settings-protocol-links-enable"
      />
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.spacing16,
    gap: spacing.spacing24,
  },
  hero: {
    alignItems: 'center',
    gap: spacing.spacing12,
    paddingTop: spacing.spacing16,
  },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primaryMuted,
  },
  title: {
    color: colors.textDefault,
    textAlign: 'center',
  },
  description: {
    color: colors.textAlternative,
    textAlign: 'center',
  },
  statusCard: {
    gap: spacing.spacing6,
    padding: spacing.spacing16,
  },
  statusLabel: {
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  statusText: {
    color: colors.textDefault,
  },
}))
