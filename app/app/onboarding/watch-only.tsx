/**
 * Add a read-only ("watch-only") Cardano wallet.
 *
 * Accepts a stake address (`stake1…`) or any of the account's base addresses
 * (`addr1…`) — the stake credential is extracted either way; an address carrying
 * none (enterprise) is watched on its own — resolves the full
 * key-credential base-address set via the stake endpoint (Koios
 * `/account_addresses`, script payments dropped), and creates a `read-only`
 * wallet group. No seed, no signing: the wallet tracks balance / assets /
 * history only (Send is gated off downstream).
 *
 * @module
 */

import {router, useLocalSearchParams} from 'expo-router'
import {useState} from 'react'
import {ScrollView, View} from 'react-native'
import {KeyboardStickyView} from 'react-native-keyboard-controller'
import {useSafeAreaInsets} from 'react-native-safe-area-context'
import {StyleSheet} from 'react-native-unistyles'

import {Button} from '../../src/components/Buttons'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {TextInput} from '../../src/components/TextInput'
import {Typography} from '../../src/components/Typography'
import {logger} from '../../src/logger'
import {useI18n, useWalletList} from '../../src/providers'
import {ReadOnlyImportError, resolveReadOnlyCardanoImport} from '../../src/services/cardano'
import {dedupeWalletName} from '../../src/utils/auto-wallet-name'

const errorKey = (reason: ReadOnlyImportError['reason']) => {
  switch (reason) {
    case 'network-mismatch':
      return 'onboarding.watchOnly.errors.networkMismatch'
    case 'script-payment':
      return 'onboarding.watchOnly.errors.scriptPayment'
    case 'no-addresses':
      return 'onboarding.watchOnly.errors.noAddresses'
    case 'unsupported-provider':
      return 'onboarding.watchOnly.errors.unavailable'
    default:
      return 'onboarding.watchOnly.errors.invalidAddress'
  }
}

export default function WatchOnlyRoute() {
  const {t} = useI18n()
  const insets = useSafeAreaInsets()
  const {createReadOnlyWallet, selectWallet, walletGroups} = useWalletList()

  // Prefilled when arriving from a `web+cardano://watch/v1` hand-off. Seeded into
  // state rather than rendered from the params, so the fields stay editable — a
  // link proposes the address, it does not fix it.
  const {address: linkAddress, name: linkName} = useLocalSearchParams<{address?: string; name?: string}>()
  const [address, setAddress] = useState(linkAddress ?? '')
  const [name, setName] = useState(linkName ?? '')
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleAdd = async () => {
    if (address.trim().length === 0 || isBusy) return
    setIsBusy(true)
    setError(null)
    try {
      const resolution = await resolveReadOnlyCardanoImport(address)
      const proposed = name.trim().length > 0 ? name.trim() : t('onboarding.watchOnly.defaultName')
      const finalName = dedupeWalletName(
        proposed,
        walletGroups.map((g) => g.name),
      )
      const groupId = await createReadOnlyWallet({
        name: finalName,
        addresses: resolution.addresses,
        checksumSeed: resolution.checksumSeedHex,
      })
      await selectWallet(groupId)
      router.replace('/wallets' as never)
    } catch (e) {
      const reason = e instanceof ReadOnlyImportError ? e.reason : null
      logger.warn('Read-only import failed', {origin: 'WatchOnly', reason: reason ?? String(e)})
      setError(t(reason !== null ? errorKey(reason) : 'onboarding.watchOnly.errors.unexpected'))
    } finally {
      setIsBusy(false)
    }
  }

  const isDisabled = address.trim().length === 0 || isBusy

  return (
    <SafeAreaViewWrapper edges={[]} style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        bounces={false}
      >
        <View style={styles.header}>
          <Typography variant="bodyMd_regular" style={styles.subtitle}>
            {t('onboarding.watchOnly.subtitle')}
          </Typography>
        </View>

        <View style={styles.field}>
          <Typography variant="bodySm_regular" style={styles.label}>
            {t('onboarding.watchOnly.addressLabel')}
          </Typography>
          <TextInput
            value={address}
            onChange={setAddress}
            placeholder={t('onboarding.watchOnly.addressPlaceholder')}
            autoCapitalize="none"
            autoCorrect={false}
            fullWidth
            autoFocus
            testID="watch-only-address-input"
          />
        </View>

        <View style={styles.field}>
          <Typography variant="bodySm_regular" style={styles.label}>
            {t('onboarding.watchOnly.nameLabel')}
          </Typography>
          <TextInput
            value={name}
            onChange={setName}
            placeholder={t('onboarding.watchOnly.namePlaceholder')}
            autoCapitalize="sentences"
            fullWidth
            testID="watch-only-name-input"
          />
        </View>

        {error && (
          <Typography variant="bodySm_regular" style={styles.errorText}>
            {error}
          </Typography>
        )}
      </ScrollView>

      <KeyboardStickyView offset={{closed: 0, opened: 20}}>
        <View style={[styles.cta, {paddingBottom: Math.max(insets.bottom, 24)}]}>
          <Button
            label={t('onboarding.watchOnly.addButton')}
            onPress={handleAdd}
            isDisabled={isDisabled}
            isLoading={isBusy}
            fullWidth
            size="xl"
            testID="watch-only-add-button"
          />
        </View>
      </KeyboardStickyView>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: theme.spacing.spacing20,
    paddingBottom: theme.spacing.spacing120,
    gap: theme.spacing.spacing24,
  },
  header: {
    paddingTop: theme.spacing.spacing24,
    gap: theme.spacing.spacing8,
  },
  subtitle: {
    color: theme.colors.textAlternative,
  },
  field: {
    gap: theme.spacing.spacing6,
  },
  label: {
    color: theme.colors.textAlternative,
  },
  errorText: {
    color: theme.colors.errorDefault,
  },
  cta: {
    paddingHorizontal: theme.spacing.spacing20,
    paddingTop: theme.spacing.spacing12,
  },
}))
