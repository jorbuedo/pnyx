/**
 * Dev-only Unicode NFC probe — does this device's `String.prototype.normalize('NFC')` work?
 *
 * Handle validation makes NFC the canonical form: the bytes claimed on chain are the composed
 * spelling, and the read gate refuses anything not already canonical. If Hermes no-ops, two users
 * can claim spellings that render identically and a name typed on a Vietnamese keyboard may never
 * match the one stored — a silent failure, since ASCII handles would work perfectly throughout.
 *
 * The vectors and the verdict live in `services/unicode-nfc-probe.ts` so the same code runs here and
 * under Node in `unicode-nfc-probe.test.ts`. That test is what pins the *expectations*; this screen
 * is what tells us whether Hermes agrees with them.
 *
 * Strings are inline English — dev-only screen.
 *
 * @module
 */

import {router} from 'expo-router'
import {useCallback, useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Button} from '../../../src/components/Buttons'
import {SafeAreaViewWrapper} from '../../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../../src/components/Typography'
import {type NfcVectorResult, type NfcVerdict, nfcVerdict, runNfcVectors} from '../../../src/services/unicode-nfc-probe'

const hexList = (cps: readonly number[]): string =>
  cps.map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`).join(' ')

const VERDICT_COPY: Record<NfcVerdict, string> = {
  ok: 'NFC works — every vector matches Node. Handle canonicalisation is sound on this device.',
  'no-op':
    'NFC IS A NO-OP — normalize returned its input. Handle canonicalisation is broken here; we would have to ship our own composition.',
  wrong:
    'NFC DISAGREES — the runtime has Unicode data but does not match Node. Do not ship handles until this is understood.',
}

export default function NfcProbeScreen() {
  const [results, setResults] = useState<readonly NfcVectorResult[] | null>(null)

  const run = useCallback(() => setResults(runNfcVectors()), [])

  const verdict = results ? nfcVerdict(results) : null

  return (
    <SafeAreaViewWrapper style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <Typography variant="headingSm">Unicode NFC probe</Typography>
          <Typography variant="bodyXs_regular" style={styles.muted}>
            Handles are stored in NFC. If this runtime cannot compose, two spellings of one name become two different
            handles.
          </Typography>
        </View>

        <View style={styles.buttons}>
          <Button label="Run vectors" variant="secondary" onPress={run} fullWidth />
          <Button label="Back" variant="nakedDefault" onPress={() => router.back()} fullWidth />
        </View>

        {verdict !== null && (
          <View style={[styles.entry, verdict !== 'ok' && styles.entryError]}>
            <Typography variant="bodySm_medium">Verdict: {verdict}</Typography>
            <Typography variant="bodyXs_regular" style={styles.muted}>
              {VERDICT_COPY[verdict]}
            </Typography>
          </View>
        )}

        <View style={styles.entries}>
          {(results ?? []).map((r) => (
            <View key={r.vector.name} style={[styles.entry, !r.ok && styles.entryError]}>
              <Typography variant="bodySm_medium">
                {r.ok ? 'PASS' : 'FAIL'} — {r.vector.name}
              </Typography>
              <Typography variant="bodyXs_regular" style={styles.muted}>
                in {hexList(r.vector.input)}
              </Typography>
              <Typography variant="bodyXs_regular" style={styles.muted}>
                want {hexList(r.vector.expected)}
              </Typography>
              <Typography variant="bodyXs_regular" style={styles.muted}>
                got {hexList(r.actual)}
              </Typography>
              {!r.ok && (
                <Typography variant="bodyXs_regular" style={styles.muted}>
                  {r.vector.why}
                </Typography>
              )}
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
