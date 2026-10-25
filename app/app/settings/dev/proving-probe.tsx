/**
 * Dev-only on-device proving probe.
 *
 * Phase-B verification surface: exercises the native `buildJoinProvenTx` bridge
 * (libmidnight_native.so → Kotlin → JS) end-to-end on real hardware. It builds a proven-unbound
 * `join` transaction entirely on the device from a committed fixture — proving the JNI
 * marshalling + native preimage → tx-level prove → serialize pipeline runs on-device and returns
 * the tagged `Transaction<signature,proof,pre-binding>` bytes the service's `submitProven` accepts.
 *
 * Inputs (fixture + artifacts) are pushed to the app's files dir — Android via adb:
 *   adb push <fixtures/artifacts> /storage/emulated/0/Android/data/<pkg>/files/proving/{state.hex,zkir,prover,verifier,srs}
 * iOS simulator via simctl (documents dir):
 *   cp <fixtures/artifacts> "$(xcrun simctl get_app_container booted <bundle-id> data)/Documents/proving/"
 * so this isolates the native path — no live chain, no network. The full live loop (fetch artifacts
 * + live state → build → POST /chain/submit) is the next milestone.
 *
 * Strings are inline English — dev-only screen, removed before the feature lands permanently.
 *
 * @module
 */

import {buildCastVoteProvenTx, buildJoinProvenTx} from '@pnyx/midnight-native'
import {File, Paths} from 'expo-file-system'
import {router, Stack} from 'expo-router'
import {useCallback, useState} from 'react'
import {Platform, ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Button} from '../../../src/components/Buttons'
import {SafeAreaViewWrapper} from '../../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../../src/components/Typography'
import {logger} from '../../../src/logger'
import {ensureCircuitArtifacts} from '../../../src/services/pnyx-artifacts'

// Android: external files dir (adb-pushable). iOS: the app container's Documents dir
// (simctl get_app_container … data → Documents/proving). Native fs reads need plain paths.
//
// Web must be its own branch, not lumped in with iOS: `Paths.document` throws
// (`this.validatePath is not a function`) and this runs at module scope, which Expo Router
// evaluates for every route at startup — so one unhandled platform here takes the whole web
// target down on load, not just this screen.
const DIR =
  Platform.OS === 'android'
    ? '/storage/emulated/0/Android/data/uk.pxkq.pnyx.dev/files/proving'
    : Platform.OS === 'web'
      ? ''
      : `${Paths.document.uri.replace(/^file:\/\//, '').replace(/\/$/, '')}/proving`
// Values recorded in fixtures/join_open_circle.inputs.json (the committed host-verified fixture).
const FIXTURE_ADDRESS = '0eb3ff0769bb6d463e221f744e1fd7dc17c6494b87161d8bcd866eda8eb363cf'
const FIXTURE_SK = '0b'.repeat(32)
/** The circle id and identity secret the `dump-*-preimage.mts` fixtures are generated with. */
const FIXTURE_CIRCLE_ID = '01'.repeat(32)
const FIXTURE_IDENTITY_SK = '07'.repeat(32)
// fixtures/cast_vote.inputs.json (member of circle 1, proposal 1 exists, ballot true/0x0d).
/**
 * The proposal contract `castVote` runs against now — a proposal is its own deploy since the circle
 * split, so this is no longer the circle's address.
 *
 * ⚠️ Regenerate the fixtures with `dump-vote-preimages.mts` and read the address out of
 * `vote.inputs.json` (`castVoteAddress`); the state and the member path come from the same run. A
 * fixture from the old shape fails as a transcript mismatch, which names neither the op nor the cause.
 */
const CASTVOTE_ADDRESS = '6c55326535e02b5c142bd56a0798c997900d66ad523a36a51ea754e88439a857'

const fromHex = (hex: string): Uint8Array => {
  const clean = hex.trim()
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

const toHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const toBase64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    out += B64.charAt(a >> 2) + B64.charAt(((a & 3) << 4) | (b >> 4))
    out += i + 1 < bytes.length ? B64.charAt(((b & 15) << 2) | (c >> 6)) : '='
    out += i + 2 < bytes.length ? B64.charAt(c & 63) : '='
  }
  return out
}

// Pushed by the host harness: adb push loop-cfg.json <DIR>/loop.json
type LoopConfig = {
  serviceUrl: string
  jwt: string
  contentCircleId: string
  /** The circle's 32-byte on-chain id, hex — a constructor argument of its contract, not a counter. */
  circleIdHex: string
  identitySkHex: string
  personaSkHex: string
  contractAddressHex: string
  networkId: string
}

type LogEntry = {readonly id: string; readonly label: string; readonly result: string; readonly isError: boolean}

export default function ProvingProbeScreen() {
  const [entries, setEntries] = useState<readonly LogEntry[]>([])
  const [busy, setBusy] = useState(false)

  const log = useCallback((label: string, result: unknown, isError = false): void => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    setEntries((prev) => [...prev, {id, label, result: text, isError}])
  }, [])

  const run = useCallback(async () => {
    setEntries([])
    setBusy(true)
    logger.info('proving probe started', {origin: 'ProvingProbeScreen'})
    try {
      const stateHex = await new File(`file://${DIR}/state.hex`).text()
      log('fixture state read', `${stateHex.trim().length / 2} bytes`)
      const t0 = Date.now()
      const tx = await buildJoinProvenTx(
        {
          zkirPath: `${DIR}/zkir`,
          proverKeyPath: `${DIR}/prover`,
          verifierKeyPath: `${DIR}/verifier`,
          paramsPath: `${DIR}/srs`,
        },
        {
          contractState: fromHex(stateHex),
          contractAddress: fromHex(FIXTURE_ADDRESS),
          circleId: fromHex(FIXTURE_CIRCLE_ID),
          identitySk: fromHex(FIXTURE_IDENTITY_SK),
          personaSk: fromHex(FIXTURE_SK),
          networkId: '',
          ttlSecs: 4_102_444_800,
        },
      )
      const ms = Date.now() - t0
      log(
        `built proven tx on-device in ${ms} ms`,
        `${tx.length} bytes — head ${toHex(tx.slice(0, 12))}`,
        tx.length === 0,
      )
      logger.info('proving probe ok', {origin: 'ProvingProbeScreen', bytes: tx.length, ms})
    } catch (e) {
      log('buildJoinProvenTx (threw)', String(e), true)
      logger.error('proving probe failed', {origin: 'ProvingProbeScreen', error: String(e)})
    } finally {
      setBusy(false)
    }
  }, [log])

  const runCastVote = useCallback(async () => {
    setEntries([])
    setBusy(true)
    try {
      // Fixture mode end-to-end: artifacts from DIR too (castvote-{zkir,prover,verifier,srs}),
      // so this button needs no service — the live loop button covers the fetch path.
      const stateHex = await new File(`file://${DIR}/castvote-state.hex`).text()
      // The member path is a fixture input now: a proposal seals its electorate and holds no tree, so
      // the caller supplies the path as of the sealed root. 20 x (32-byte LE sibling, 1 byte goes_left).
      const pathHex = await new File(`file://${DIR}/castvote-memberpath.hex`).text()
      const t0 = Date.now()
      const tx = await buildCastVoteProvenTx({
        zkirPath: `${DIR}/castvote-zkir`,
        proverKeyPath: `${DIR}/castvote-prover`,
        verifierKeyPath: `${DIR}/castvote-verifier`,
        paramsPath: `${DIR}/castvote-srs`,
        contractState: fromHex(stateHex),
        contractAddress: fromHex(CASTVOTE_ADDRESS),
        personaSk: fromHex(FIXTURE_SK),
        // A `Uint<8>` option, not a boolean — yes/no is just `optionCount = 2`.
        ballotOption: 2,
        ballotRand: fromHex('0d'.repeat(32)),
        memberPath: fromHex(pathHex.trim()),
        networkId: 'undeployed',
        ttlSecs: 4_102_444_800,
      })
      log(
        `built castVote tx on-device in ${Date.now() - t0} ms`,
        `${tx.length} bytes — head ${toHex(tx.slice(0, 12))}`,
        tx.length === 0,
      )
    } catch (e) {
      log('buildCastVoteProvenTx (threw)', String(e), true)
    } finally {
      setBusy(false)
    }
  }, [log])

  const runLive = useCallback(async () => {
    setEntries([])
    setBusy(true)
    logger.info('proving live loop started', {origin: 'ProvingProbeScreen'})
    try {
      const cfg = JSON.parse(await new File(`file://${DIR}/loop.json`).text()) as LoopConfig
      log('config', `circle ${cfg.circleIdHex.slice(0, 16)}… @ ${cfg.serviceUrl}`)
      const paths = await ensureCircuitArtifacts('join', 'circle')
      log('artifacts fetched + cached', paths.zkirPath.replace(/^.*\/pnyx-artifacts\//, '…/'))
      const stateRes = await fetch(`${cfg.serviceUrl}/chain/state`)
      const {state} = (await stateRes.json()) as {state: string}
      log('live state fetched', `${state.length / 2} bytes`)
      const t0 = Date.now()
      const tx = await buildJoinProvenTx(paths, {
        contractState: fromHex(state),
        contractAddress: fromHex(cfg.contractAddressHex),
        circleId: fromHex(cfg.circleIdHex),
        identitySk: fromHex(cfg.identitySkHex),
        personaSk: fromHex(cfg.personaSkHex),
        networkId: cfg.networkId,
        ttlSecs: Math.floor(Date.now() / 1000) + 3600,
      })
      log(`built proven tx vs live state in ${Date.now() - t0} ms`, `${tx.length} bytes`)
      const submitRes = await fetch(`${cfg.serviceUrl}/chain/submit`, {
        method: 'POST',
        headers: {'content-type': 'application/json', authorization: `Bearer ${cfg.jwt}`},
        body: JSON.stringify({tx: toBase64(tx), ref: {kind: 'membership', circleId: cfg.contentCircleId}}),
      })
      log(`POST /chain/submit → ${submitRes.status}`, await submitRes.text(), submitRes.status >= 300)
      logger.info('proving live loop submitted', {origin: 'ProvingProbeScreen', status: submitRes.status})
    } catch (e) {
      log('live loop (threw)', String(e), true)
      logger.error('proving live loop failed', {origin: 'ProvingProbeScreen', error: String(e)})
    } finally {
      setBusy(false)
    }
  }, [log])

  return (
    <SafeAreaViewWrapper style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{headerTitle: 'On-device proving probe'}} />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <Typography variant="headingSm">On-device proving probe</Typography>
          <Typography variant="bodySm_regular" style={styles.muted}>
            Builds a proven-unbound join transaction natively from the committed fixture. Verifies the native bridge
            (JNI on Android, C-ABI/Swift on iOS) + prove pipeline run on this hardware. Push fixtures to {DIR} first.
          </Typography>
        </View>
        <View style={styles.buttons}>
          <Button
            label={busy ? 'Building…' : 'Build join tx (device)'}
            variant="primary"
            onPress={run}
            disabled={busy}
            fullWidth
          />
          <Button
            label={busy ? 'Building…' : 'Build castVote tx (device, fixture)'}
            variant="secondary"
            onPress={runCastVote}
            disabled={busy}
            fullWidth
          />
          <Button
            label={busy ? 'Running…' : 'Run live loop (build vs live state → submit)'}
            variant="secondary"
            onPress={runLive}
            disabled={busy}
            fullWidth
          />
          <Button label="Clear" variant="nakedDefault" onPress={() => setEntries([])} fullWidth />
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
  safeArea: {flex: 1},
  scrollContent: {
    paddingHorizontal: theme.spacing.spacing16,
    paddingTop: theme.spacing.spacing8,
    paddingBottom: theme.spacing.spacing24,
    gap: theme.spacing.spacing16,
  },
  header: {gap: theme.spacing.spacing8},
  muted: {color: theme.colors.textAlternative},
  buttons: {gap: theme.spacing.spacing8},
  entries: {gap: theme.spacing.spacing8},
  entry: {
    padding: theme.spacing.spacing12,
    borderRadius: theme.borderRadius.rounded12,
    borderWidth: 1,
    borderColor: theme.colors.borderDefaultWeak,
    backgroundColor: theme.colors.backgroundAlternativeHover,
    gap: theme.spacing.spacing4,
  },
  entryError: {borderColor: theme.colors.errorDefault},
}))
