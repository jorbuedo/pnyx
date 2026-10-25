/**
 * Hardware pairing/import flow for Cardano: scan → connect → pick account →
 * import as a hardware wallet group. Trezor PIN/passphrase/pairing prompts are
 * driven by the service's `trezorUIRequest` (mirrored into the provider).
 *
 * Also the way back to a connected device for the two things that need one after
 * the wallet exists — adding an account, and reading the CIP-1854 co-signer key
 * for a wallet imported before that key was read. Both begin with the same scan
 * and connect, so they are modes here rather than screens of their own; see the
 * mode comment in the body.
 *
 * `startScan` streams both transports at once: the platform BLE scan (Ledger
 * Nano X/Stax/Flex/Apex and Trezor Safe 5/7 by advertised service UUID, iOS +
 * Android) and, on Android, Ledger + Trezor attached over USB. The chips state
 * which transports are live rather than offering tabs to pick between them — a
 * plugged device and a nearby device are both just rows.
 *
 * Bluetooth being unavailable is a warning, not a failure: a cabled Trezor still
 * pairs with the radio off, so USB rows keep streaming and only the chip and a
 * toast reflect the missing transport.
 *
 * Device rows show only what the scans actually return (name, vendor,
 * transport) — no invented signal/battery metadata.
 *
 * Non-Midnight only — hardware never backs the software-only Midnight identity.
 *
 * @module
 */

import {CARDANO_MAINNET} from '@pnyx/config'
import type {DetectedDevice, HardwareAccount} from '@pnyx/hardware/service'
import {useLocalSearchParams, useRouter} from 'expo-router'
import {useCallback, useEffect, useRef, useState} from 'react'
import {ActivityIndicator, Platform, View} from 'react-native'
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../components/Buttons/Button'
import {Card} from '../../components/Card'
import {ChamferBackground} from '../../components/Chamfer'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {SectionHeader} from '../../components/SectionHeader'
import {StickyFooter} from '../../components/StickyFooter'
import {Typography} from '../../components/Typography'
import {UniIcon} from '../../components/UniIcon'
import {useToast} from '../../hooks/useToast'
import {logger} from '../../logger'
import {useI18n, useWalletAddress, useWalletData, useWalletList} from '../../providers'
import {useHardwareWallet} from '../../providers/HardwareWalletProvider'
import {formatAuthor} from '../../services/pnyx-forum'
import {dedupeWalletName} from '../../utils/auto-wallet-name'
import {resolveDeviceDisplayName} from './device-display-name'

type Stage = 'scan' | 'accounts'

const PULSE_COUNT = 3
const PULSE_DURATION_MS = 2_000

const bytesToHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** Vendor / transport labels come from the scan result — never guessed. */
const vendorKey = (device: DetectedDevice) =>
  device.type === 'ledger' ? ('hardware.vendor.ledger' as const) : ('hardware.vendor.trezor' as const)

const transportKey = (device: DetectedDevice) => {
  switch (device.transportType) {
    case 'bluetooth':
      return 'hardware.transport.bluetooth' as const
    case 'usb':
      return 'hardware.transport.usb' as const
    case 'webhid':
    case 'webusb':
      return 'hardware.transport.web' as const
  }
}

export const HardwarePairScreen = () => {
  const {t} = useI18n()
  const router = useRouter()
  const {showToast} = useToast()
  const hardware = useHardwareWallet()
  const {selectWallet, walletGroups} = useWalletList()
  const {getReceiveAddress} = useWalletAddress()
  const {getAccountXPub} = useWalletData()

  // Three modes, all reached through this screen because all three begin with
  // the same scan-and-connect:
  //  - no params      → import a new hardware wallet
  //  - ?groupId       → add another device account to that group
  //  - &mode=shared-key → read the CIP-1854 co-signer key for a group that has
  //    none, and come straight back. No account list: the accounts are already
  //    known, so picking one would be asking a question with one right answer.
  const {groupId: targetGroupId, mode} = useLocalSearchParams<{groupId?: string; mode?: string}>()
  const hasGroup = typeof targetGroupId === 'string' && targetGroupId.length > 0
  const sharedKeyMode = hasGroup && mode === 'shared-key'
  const addToGroupId = hasGroup ? targetGroupId : undefined
  const addMode = hasGroup && !sharedKeyMode
  // Cardano addresses already imported into the target group — device accounts
  // matching one are shown as "Added" so the same account isn't imported twice.
  const [importedAddresses, setImportedAddresses] = useState<ReadonlySet<string>>(new Set())

  const [stage, setStage] = useState<Stage>('scan')
  const [scanning, setScanning] = useState(false)
  const [devices, setDevices] = useState<readonly DetectedDevice[]>([])
  const [selectedDevice, setSelectedDevice] = useState<DetectedDevice | null>(null)
  const [accounts, setAccounts] = useState<readonly HardwareAccount[]>([])
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [importingPath, setImportingPath] = useState<string | null>(null)
  // Surface the full troubleshooting steps only once a connect has failed —
  // before that the short intro is enough.
  const [showTroubleshoot, setShowTroubleshoot] = useState(false)
  const [bluetoothUnavailable, setBluetoothUnavailable] = useState(false)
  // Don't pulse a Bluetooth mark while the radio is the one transport that isn't
  // working — USB is what's actually scanning in that case.
  const heroIcon = bluetoothUnavailable && hardware.usbSupported ? 'usb' : 'bluetooth'
  const busy = connectingId !== null || importingPath !== null

  // The BLE scan runs until explicitly unsubscribed — stop it when a device is
  // chosen and on unmount so we don't keep the radio busy in the background.
  const stopScanRef = useRef<(() => void) | null>(null)
  const stopScan = useCallback(() => {
    stopScanRef.current?.()
    stopScanRef.current = null
    setScanning(false)
  }, [])
  useEffect(() => () => stopScanRef.current?.(), [])

  const startScan = useCallback(async () => {
    stopScanRef.current?.()
    setDevices([])
    setBluetoothUnavailable(false)
    setScanning(true)
    try {
      const seen = new Map<string, DetectedDevice>()
      stopScanRef.current = await hardware.startScan(
        (device) => {
          seen.set(device.id, device)
          setDevices([...seen.values()])
        },
        () => {
          // USB discovery is unaffected — warn and keep the scan running.
          setBluetoothUnavailable(true)
          showToast({variant: 'warning', message: t('hardware.errors.bluetoothUnavailable')})
        },
      )
    } catch (e: unknown) {
      // The toast blames Bluetooth for anything that goes wrong in the scan.
      logger.warn('Hardware scan failed', {origin: 'HardwarePairScreen', error: String(e)})
      showToast({variant: 'error', message: t('hardware.errors.bluetoothUnavailable')})
      setScanning(false)
    }
  }, [hardware, showToast, t])

  // Read the co-signer key for every Cardano account already in the group. The
  // stored CIP-1852 xpub of each is what the device is checked against, so a
  // different device — or the right device under a different Trezor passphrase —
  // is refused rather than having its key filed as this wallet's.
  const importSharedKeys = useCallback(
    async (device: DetectedDevice) => {
      if (targetGroupId === undefined) return
      const group = walletGroups.find((g) => g.groupId === targetGroupId)
      const indices = group?.primaryWallet.accounts.map((a) => a.index) ?? []
      const accounts = (
        await Promise.all(
          indices.map(async (accountIndex) => {
            const xpub = await getAccountXPub(CARDANO_MAINNET, targetGroupId, accountIndex).catch((e) => {
              logger.warn('Account xpub read failed; that account is left out of the pairing', {
                origin: 'HardwarePairScreen',
                accountIndex,
                error: String(e),
              })
              return null
            })
            return xpub === null ? null : {accountIndex, accountXpubHex: bytesToHex(xpub)}
          }),
        )
      ).filter((a): a is {accountIndex: number; accountXpubHex: string} => a !== null)

      if (accounts.length === 0) {
        showToast({variant: 'error', message: t('multisig.create.deviceKeyFailed')})
        return
      }
      const result = await hardware.importSharedKeys({device, groupId: targetGroupId, accounts})
      if (result.status === 'ok') {
        showToast({variant: 'success', message: t('multisig.create.deviceKeyImported')})
        router.back()
        return
      }
      showToast({
        variant: 'error',
        message: t(
          result.status === 'wrong-device' ? 'multisig.create.deviceKeyWrongDevice' : 'multisig.create.deviceKeyFailed',
        ),
      })
    },
    [targetGroupId, walletGroups, getAccountXPub, hardware, showToast, t, router],
  )

  const onSelectDevice = useCallback(
    async (device: DetectedDevice) => {
      setConnectingId(device.id)
      // Stop the app scan before connecting so the BLE adapter is free — the
      // Trezor connect opens its own transport and a live scan conflicts with it.
      stopScan()
      try {
        await hardware.connect(device)
        // Discovery can't know the user-set label over USB (the string descriptor
        // is a fixed vendor string), so take it from the device now that it is
        // answering — otherwise a cabled Trezor imports as a generic "Trezor".
        const label = await hardware.getConnectedDeviceLabel()
        const named = {...device, name: resolveDeviceDisplayName({scanName: device.name, deviceLabel: label})}
        setSelectedDevice(named)
        if (sharedKeyMode) {
          await importSharedKeys(named)
          return
        }
        const found = await hardware.getCardanoAccounts(5)
        setAccounts(found)
        setStage('accounts')
      } catch (error) {
        logger.error('Hardware connect failed', {
          origin: 'HardwarePairScreen',
          deviceType: device.type,
          error: String(error),
        })
        setShowTroubleshoot(true)
        showToast({variant: 'error', message: t('hardware.errors.connectFailed')})
      } finally {
        setConnectingId(null)
      }
    },
    [hardware, showToast, stopScan, t, sharedKeyMode, importSharedKeys],
  )

  // Load the target group's existing Cardano addresses so already-imported
  // device accounts are shown as "Added" and can't be imported twice.
  useEffect(() => {
    if (!addMode || addToGroupId === undefined) return
    let active = true
    const group = walletGroups.find((g) => g.groupId === addToGroupId)
    const indices = group?.primaryWallet.accounts.map((a) => a.index) ?? []
    void Promise.all(
      indices.map((accountIndex) =>
        getReceiveAddress({groupId: addToGroupId, chainId: CARDANO_MAINNET, accountIndex}).catch((e) => {
          logger.warn('Receive address read failed; that account cannot be marked as imported', {
            origin: 'HardwarePairScreen',
            accountIndex,
            error: String(e),
          })
          return undefined
        }),
      ),
    ).then((addrs) => {
      if (active) setImportedAddresses(new Set(addrs.filter((a): a is string => a !== undefined)))
    })
    return () => {
      active = false
    }
  }, [addMode, addToGroupId, walletGroups, getReceiveAddress])

  const onImport = useCallback(
    async (account: HardwareAccount) => {
      if (selectedDevice === null) return
      setImportingPath(account.path)
      try {
        if (addMode && addToGroupId !== undefined) {
          // Add this account to the existing hardware group, then land back on
          // Wallets with the new account active.
          await hardware.addAccountToGroup({device: selectedDevice, account, groupId: addToGroupId})
          showToast({variant: 'success', message: t('hardware.accountAdded')})
          router.replace('/wallets' as never)
          return
        }
        // Name the wallet after the connected device; fall back to the generic
        // label only if the scan gave us no name.
        const proposed = selectedDevice.name.trim().length > 0 ? selectedDevice.name.trim() : t('hardware.defaultName')
        const name = dedupeWalletName(
          proposed,
          walletGroups.map((g) => g.name),
        )
        const groupId = await hardware.importCardanoAccount({device: selectedDevice, account, name})
        showToast({variant: 'success', message: t('hardware.imported')})
        // Land on the Wallets tab with the freshly-imported group active, rather
        // than falling back to the add-wallet chooser we came from.
        await selectWallet(groupId)
        router.replace('/wallets' as never)
      } catch (e: unknown) {
        logger.warn('Hardware wallet import failed', {origin: 'HardwarePairScreen', addMode, error: String(e)})
        showToast({
          variant: 'error',
          message: t(addMode ? 'hardware.errors.addAccountFailed' : 'hardware.errors.importFailed'),
        })
      } finally {
        setImportingPath(null)
      }
    },
    [hardware, selectedDevice, showToast, t, router, selectWallet, walletGroups, addMode, addToGroupId],
  )

  return (
    <SafeAreaViewWrapper
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.content}
      stickyFooter={
        stage === 'scan' ? (
          <StickyFooter>
            <Button
              label={scanning ? t('hardware.scanningButton') : t('hardware.scanButton')}
              onPress={startScan}
              fullWidth
              size="xl"
              isLoading={scanning}
              disabled={busy}
              testID="hardware-scan"
            />
          </StickyFooter>
        ) : undefined
      }
    >
      {stage === 'scan' ? (
        <>
          <View style={styles.transportRow}>
            {hardware.usbSupported && (
              <TransportChip icon="usb" label={t('hardware.transport.usb')} active testID="hardware-transport-usb" />
            )}
            <TransportChip
              icon="bluetooth"
              label={t('hardware.transport.bluetooth')}
              active={!bluetoothUnavailable}
              testID="hardware-transport-bluetooth"
            />
          </View>

          <ScanHero scanning={scanning} icon={heroIcon} />
          <Typography variant="bodyMd_regular" style={styles.scanLabel}>
            {scanning ? t('hardware.scanning') : ''}
          </Typography>

          {showTroubleshoot ? (
            <View style={styles.helpCard} testID="hardware-troubleshoot">
              <ChamferBackground size="auto" fillToken="backgroundAlternative" borderToken="borderDefaultWeak" />
              <Typography variant="bodyMd_medium" style={styles.helpTitle}>
                {t('hardware.help.troubleshootTitle')}
              </Typography>
              {[
                t('hardware.help.step1'),
                t('hardware.help.step2'),
                t('hardware.help.step3'),
                t('hardware.help.step4'),
                ...(hardware.usbSupported ? [t('hardware.help.stepUsb')] : []),
              ].map((step, i) => (
                <View key={step} style={styles.helpStep}>
                  <Typography variant="bodySm_medium" style={styles.helpStepNum}>
                    {`${i + 1}.`}
                  </Typography>
                  <Typography variant="bodySm_regular" style={styles.helpStepText}>
                    {step}
                  </Typography>
                </View>
              ))}
            </View>
          ) : (
            <Typography variant="bodyMd_regular" style={styles.helpIntro} testID="hardware-intro">
              {t(hardware.usbSupported ? 'hardware.help.introUsb' : 'hardware.help.intro')}
            </Typography>
          )}

          {devices.length > 0 && (
            <View style={styles.section}>
              <SectionHeader title={t('hardware.foundTitle')} />
              {devices.map((device) => (
                <DeviceRow
                  key={device.id}
                  title={device.name}
                  meta={`${t(vendorKey(device))} · ${t(transportKey(device))}`}
                  icon={device.type === 'ledger' ? 'ledger' : 'trezor'}
                  disabled={busy}
                  loading={connectingId === device.id}
                  onPress={() => onSelectDevice(device)}
                  testID={`hardware-device-${device.id}`}
                />
              ))}
            </View>
          )}
        </>
      ) : (
        <View style={styles.section}>
          {selectedDevice !== null && (
            <View style={styles.connectedBanner}>
              <ChamferBackground size="auto" fillToken="backgroundAlternative" borderToken="successDefault" />
              <UniIcon
                name="check"
                width={18}
                height={18}
                uniProps={(theme) => ({color: theme.colors.successDefault})}
              />
              <View style={styles.connectedBannerText}>
                <Typography variant="bodyMd_medium">{selectedDevice.name}</Typography>
                <Typography variant="bodyXs_regular" style={styles.muted}>
                  {`${t(vendorKey(selectedDevice))} · ${t(transportKey(selectedDevice))} · ${t('hardware.connectedTitle')}`}
                </Typography>
              </View>
            </View>
          )}

          {selectedDevice?.type === 'ledger' && (
            <Typography variant="bodySm_regular" style={styles.muted}>
              {t('hardware.openAppPrompt')}
            </Typography>
          )}

          <SectionHeader title={t('hardware.selectAccount')} />
          {accounts.map((account) => {
            const alreadyImported = importedAddresses.has(account.address)
            return (
              <DeviceRow
                key={account.path}
                title={t('hardware.accountLabel', {index: account.index})}
                meta={account.path}
                metaMono
                secondary={
                  alreadyImported
                    ? `${t('hardware.alreadyAdded')} · ${formatAuthor(account.address, 20)}`
                    : formatAuthor(account.address, 24)
                }
                icon="wallet"
                disabled={busy || alreadyImported}
                loading={importingPath === account.path}
                onPress={() => onImport(account)}
                testID={`hardware-account-${account.index}`}
              />
            )
          })}
        </View>
      )}
    </SafeAreaViewWrapper>
  )
}

/**
 * A transport the scan is using. `active={false}` marks one that exists on this
 * platform but isn't usable right now (Bluetooth off / permission denied), which
 * is why it dims instead of disappearing — a vanished chip reads as "this device
 * has no Bluetooth" rather than "turn Bluetooth on".
 */
const TransportChip = ({
  icon,
  label,
  active,
  testID,
}: {
  readonly icon: 'usb' | 'bluetooth'
  readonly label: string
  readonly active: boolean
  readonly testID: string
}) => {
  styles.useVariants({transportActive: active})
  return (
    <View style={styles.transportChip} testID={testID}>
      <ChamferBackground size="auto" fillToken="backgroundAlternative" borderToken="borderDefaultWeak" />
      <UniIcon
        name={icon}
        width={14}
        height={14}
        uniProps={(theme) => ({color: active ? theme.colors.primaryDefault : theme.colors.textMuted})}
      />
      <Typography variant="bodyXs_medium" style={styles.transportChipLabel}>
        {label}
      </Typography>
    </View>
  )
}

/** Staggered start offsets for the scan pulse rings (fixed, so also the keys). */
const PULSE_DELAYS_MS = Array.from({length: PULSE_COUNT}, (_, i) => (PULSE_DURATION_MS / PULSE_COUNT) * i)

/** Pulsing rings while scanning; a static device mark when idle. */
const ScanHero = ({scanning, icon}: {scanning: boolean; icon: 'usb' | 'bluetooth'}) => (
  <View style={styles.scanHero}>
    {scanning && PULSE_DELAYS_MS.map((delayMs) => <PulseRing key={delayMs} delayMs={delayMs} />)}
    <View style={styles.scanHeroIcon}>
      <UniIcon name={icon} width={26} height={26} uniProps={(theme) => ({color: theme.colors.primaryDefault})} />
    </View>
  </View>
)

const PulseRing = ({delayMs}: {delayMs: number}) => {
  const progress = useSharedValue(0)
  useEffect(() => {
    progress.value = withDelay(
      delayMs,
      withRepeat(withTiming(1, {duration: PULSE_DURATION_MS, easing: Easing.out(Easing.quad)}), -1, false),
    )
  }, [progress, delayMs])
  const animated = useAnimatedStyle(() => ({
    transform: [{scale: 1 + progress.value * 1.6}],
    opacity: 1 - progress.value,
  }))
  return <Animated.View style={[styles.pulseRing, animated]} />
}

type DeviceRowProps = {
  readonly title: string
  readonly meta: string
  readonly metaMono?: boolean
  readonly secondary?: string
  readonly icon: 'ledger' | 'trezor' | 'wallet'
  readonly disabled: boolean
  readonly loading: boolean
  readonly onPress: () => void
  readonly testID: string
}

export const DeviceRow = ({
  title,
  meta,
  metaMono,
  secondary,
  icon,
  disabled,
  loading,
  onPress,
  testID,
}: DeviceRowProps) => (
  <Card
    variant="outlined"
    fillToken="backgroundDefault"
    style={styles.deviceRow}
    testID={testID}
    {...(disabled ? {} : {onPress})}
  >
    <View style={styles.deviceRowIcon}>
      <ChamferBackground size="auto" fillToken="backgroundAlternative" borderToken="borderDefaultWeak" />
      <UniIcon name={icon} width={20} height={20} uniProps={(theme) => ({color: theme.colors.textDefault})} />
    </View>
    <View style={styles.deviceRowBody}>
      <Typography variant="bodyMd_medium">{title}</Typography>
      <Typography variant="bodyXs_regular" style={[styles.muted, metaMono === true && styles.mono]}>
        {meta}
      </Typography>
      {secondary !== undefined && (
        <Typography variant="bodyXs_regular" style={styles.muted} numberOfLines={1}>
          {secondary}
        </Typography>
      )}
    </View>
    {loading ? (
      <ActivityIndicator size="small" />
    ) : (
      <UniIcon name="rightThin" width={14} height={14} uniProps={(theme) => ({color: theme.colors.textMuted})} />
    )}
  </Card>
)

const styles = StyleSheet.create((theme) => ({
  content: {padding: theme.spacing.spacing16, gap: theme.spacing.spacing16},
  section: {gap: theme.spacing.spacing8},
  transportRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: theme.spacing.spacing8,
  },
  transportChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing4,
    paddingHorizontal: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing4,
  },
  transportChipLabel: {
    variants: {
      transportActive: {
        true: {color: theme.colors.textDefault},
        false: {color: theme.colors.textMuted},
      },
    },
  },
  scanHero: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 140,
  },
  scanHeroIcon: {
    width: 64,
    height: 64,
    borderRadius: theme.borderRadius.roundedCircle,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.backgroundAlternative,
    borderWidth: theme.borderWidth.s,
    borderColor: theme.colors.borderDefaultWeak,
  },
  pulseRing: {
    position: 'absolute',
    width: 64,
    height: 64,
    borderRadius: theme.borderRadius.roundedCircle,
    borderWidth: theme.borderWidth.m,
    borderColor: theme.colors.primaryDefault,
  },
  scanLabel: {
    color: theme.colors.textMuted,
    textAlign: 'center',
  },
  helpIntro: {
    color: theme.colors.textMuted,
    textAlign: 'center',
    paddingHorizontal: theme.spacing.spacing8,
  },
  helpCard: {
    gap: theme.spacing.spacing8,
    padding: theme.spacing.spacing16,
  },
  helpTitle: {
    color: theme.colors.textDefault,
  },
  helpStep: {
    flexDirection: 'row',
    gap: theme.spacing.spacing8,
    alignItems: 'flex-start',
  },
  helpStepNum: {
    color: theme.colors.primaryDefault,
  },
  helpStepText: {
    color: theme.colors.textMuted,
    flex: 1,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing12,
    padding: theme.spacing.spacing12,
  },
  deviceRowIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deviceRowBody: {
    flex: 1,
    gap: 2,
  },
  connectedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing12,
    padding: theme.spacing.spacing12,
  },
  connectedBannerText: {
    flex: 1,
    gap: 2,
  },
  muted: {
    color: theme.colors.textMuted,
  },
  mono: {
    fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'}),
  },
}))
