/**
 * Dev-only keychain probe.
 *
 * Phase A verification surface for the encryption-enclave rework. Exercises
 * `react-native-keychain` end-to-end so we can confirm on real devices:
 *
 *   - `getSecurityLevel()` reports SECURE_HARDWARE on TEE devices
 *   - `getSupportedBiometryType()` reports Face/Touch/Fingerprint correctly
 *   - `setGenericPassword` with BIOMETRY_ANY_OR_DEVICE_PASSCODE writes
 *   - `getGenericPassword` triggers the OS biometric / passcode prompt and
 *     returns the value
 *   - `hasGenericPassword` does NOT trigger an auth prompt
 *   - `getAllGenericPasswordServices` enumerates without auth prompt
 *   - `resetGenericPassword` clears the entry
 *   - `cloudSync` is omitted entirely — iOS native treats any value
 *     (including `false`) as truthy, which sets `kSecAttrSynchronizable`
 *     and breaks the access-control write
 *
 * Strings are inline English — this screen ships only in dev builds and is
 * removed before the rework lands as a permanent feature.
 *
 * @module
 */

import {router, Stack} from 'expo-router'
import {useCallback, useRef, useState} from 'react'
import {Platform, ScrollView, View} from 'react-native'
import * as Keychain from 'react-native-keychain'
import {StyleSheet} from 'react-native-unistyles'

import {Button} from '../../../src/components/Buttons'
import {SafeAreaViewWrapper} from '../../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../../src/components/Typography'
import {logger} from '../../../src/logger'
import {probeDeviceLockCapability} from '../../../src/services/keychain-capability'

const PROBE_SERVICE = '@pnyx/mnemonic/__probe__'
const PROBE_USERNAME = 'probe'
const PROBE_PAYLOAD = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`

type LogEntry = {
  readonly id: string
  readonly label: string
  readonly result: string
  readonly isError: boolean
}

export default function KeychainProbeScreen() {
  const [entries, setEntries] = useState<readonly LogEntry[]>([])
  // `payload` is read inside async closures whose identity is captured by
  // `runFullSuite`'s callback. If we read state directly, the captured
  // closure of `runRetrieve` keeps pointing at the old `payload` value
  // even after `runStore` updates state — so the equality check in
  // `runRetrieve` always compared against a stale expected value. The
  // ref always reflects the latest write.
  const [payload, setPayload] = useState<string>(PROBE_PAYLOAD)
  const payloadRef = useRef<string>(PROBE_PAYLOAD)
  payloadRef.current = payload

  const log = useCallback((label: string, result: unknown, isError = false): void => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    setEntries((prev) => [...prev, {id, label, result: text, isError}])
  }, [])

  const clear = useCallback(() => {
    setEntries([])
  }, [])

  const runCapability = useCallback(async () => {
    try {
      const cap = await probeDeviceLockCapability()
      log('probeDeviceLockCapability', cap)
    } catch (e) {
      log('probeDeviceLockCapability (threw)', String(e), true)
    }
  }, [log])

  const runSecurityLevel = useCallback(async () => {
    try {
      const level = await Keychain.getSecurityLevel()
      log('getSecurityLevel', level ?? 'null')
    } catch (e) {
      log('getSecurityLevel (threw)', String(e), true)
    }
  }, [log])

  const runBiometryType = useCallback(async () => {
    try {
      const type = await Keychain.getSupportedBiometryType()
      log('getSupportedBiometryType', type ?? 'null')
    } catch (e) {
      log('getSupportedBiometryType (threw)', String(e), true)
    }
  }, [log])

  const runStore = useCallback(async () => {
    try {
      // Fresh payload each run so we can verify retrieval returns what we wrote.
      const fresh = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`
      setPayload(fresh)
      // Write the ref synchronously so a subsequent runRetrieve (in the
      // same `runFullSuite` callback identity) sees the new expected
      // value — React state has a render-cycle latency that the suite
      // closure outruns.
      payloadRef.current = fresh
      // `cloudSync` must stay omitted — see enclave-vault.ts writeOptions
      // for the access-control root cause.
      const result = await Keychain.setGenericPassword(PROBE_USERNAME, fresh, {
        service: PROBE_SERVICE,
        accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
        accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        ...(Platform.OS === 'android' && {
          storage: Keychain.STORAGE_TYPE.AES_GCM,
          securityLevel: Keychain.SECURITY_LEVEL.SECURE_HARDWARE,
        }),
        authenticationPrompt: {title: 'Authorize storing probe value'},
      })
      log(`setGenericPassword (wrote ${fresh.length} chars)`, result)
    } catch (e) {
      log('setGenericPassword (threw)', String(e), true)
    }
  }, [log])

  const runHas = useCallback(async () => {
    try {
      const has = await Keychain.hasGenericPassword({service: PROBE_SERVICE})
      log('hasGenericPassword (no auth prompt expected)', has)
    } catch (e) {
      log('hasGenericPassword (threw)', String(e), true)
    }
  }, [log])

  const runEnumerate = useCallback(async () => {
    try {
      const services = await Keychain.getAllGenericPasswordServices()
      log('getAllGenericPasswordServices (no auth prompt expected)', services)
    } catch (e) {
      log('getAllGenericPasswordServices (threw)', String(e), true)
    }
  }, [log])

  const runRetrieve = useCallback(async () => {
    try {
      const result = await Keychain.getGenericPassword({
        service: PROBE_SERVICE,
        authenticationPrompt: {title: 'Authorize reading probe value'},
      })
      if (result === false) {
        log('getGenericPassword', 'false (no entry)')
        return
      }
      const matches = result.password === payloadRef.current
      log(
        `getGenericPassword (matches expected: ${matches})`,
        {
          service: result.service,
          username: result.username,
          storage: result.storage,
          passwordLength: result.password.length,
        },
        !matches,
      )
    } catch (e) {
      log('getGenericPassword (threw)', String(e), true)
    }
    // No `payload` dependency — we read `payloadRef.current` at call
    // time so the callback identity stays stable across payload
    // updates. Otherwise `runFullSuite`'s captured `runRetrieve`
    // pointed at a pre-`runStore` payload and the comparison always
    // failed.
  }, [log])

  const runReset = useCallback(async () => {
    try {
      const ok = await Keychain.resetGenericPassword({service: PROBE_SERVICE})
      log('resetGenericPassword', ok)
    } catch (e) {
      log('resetGenericPassword (threw)', String(e), true)
    }
  }, [log])

  const runFullSuite = useCallback(async () => {
    clear()
    logger.info('Keychain probe suite started', {origin: 'KeychainProbeScreen'})
    await runCapability()
    await runSecurityLevel()
    await runBiometryType()
    await runStore()
    await runHas()
    await runEnumerate()
    await runRetrieve()
    await runReset()
    await runHas()
    logger.info('Keychain probe suite finished', {origin: 'KeychainProbeScreen'})
  }, [clear, runCapability, runSecurityLevel, runBiometryType, runStore, runHas, runEnumerate, runRetrieve, runReset])

  return (
    <SafeAreaViewWrapper style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{headerTitle: 'Keychain probe'}} />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <Typography variant="headingSm">Keychain probe</Typography>
          <Typography variant="bodySm_regular" style={styles.muted}>
            Dev-only verification for the encryption-enclave rework (Phase A). Exercises react-native-keychain with the
            production options the vault will use.
          </Typography>
        </View>

        <View style={styles.buttons}>
          <Button label="Run full suite" variant="primary" onPress={runFullSuite} fullWidth />
          <Button label="Capability probe" variant="secondary" onPress={runCapability} fullWidth />
          <Button label="Security level (Android)" variant="secondary" onPress={runSecurityLevel} fullWidth />
          <Button label="Biometry type" variant="secondary" onPress={runBiometryType} fullWidth />
          <Button label="Store probe value" variant="secondary" onPress={runStore} fullWidth />
          <Button label="Has probe entry" variant="secondary" onPress={runHas} fullWidth />
          <Button label="Enumerate services" variant="secondary" onPress={runEnumerate} fullWidth />
          <Button label="Retrieve probe value" variant="secondary" onPress={runRetrieve} fullWidth />
          <Button label="Reset probe entry" variant="secondary" onPress={runReset} fullWidth />
          <Button label="Clear log" variant="nakedDefault" onPress={clear} fullWidth />
          <Button label="Back" variant="nakedDefault" onPress={() => router.back()} fullWidth />
        </View>

        <View style={styles.entries}>
          {entries.map((e) => (
            <View key={e.id} style={[styles.entry, e.isError && styles.entryError]}>
              <Typography variant="bodySm_medium">{e.label}</Typography>
              <Typography variant="bodyXs_regular" style={styles.muted}>
                {e.result}
              </Typography>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: theme.spacing.spacing16,
    paddingTop: theme.spacing.spacing8,
    paddingBottom: theme.spacing.spacing24,
    gap: theme.spacing.spacing16,
  },
  header: {
    gap: theme.spacing.spacing8,
  },
  muted: {
    color: theme.colors.textAlternative,
  },
  buttons: {
    gap: theme.spacing.spacing8,
  },
  entries: {
    gap: theme.spacing.spacing8,
  },
  entry: {
    padding: theme.spacing.spacing12,
    borderRadius: theme.borderRadius.rounded12,
    borderWidth: 1,
    borderColor: theme.colors.borderDefaultWeak,
    backgroundColor: theme.colors.backgroundAlternativeHover,
    gap: theme.spacing.spacing4,
  },
  entryError: {
    borderColor: theme.colors.errorDefault,
  },
}))
