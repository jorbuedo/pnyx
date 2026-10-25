/**
 * Dev-only case-fold probe — does this device's `toLowerCase` agree with the reference?
 *
 * A handle contract's address derives from the folded bytes, so a divergence here derives an address
 * the app can neither find nor bind, and it reads on screen as *"that name is free"*. Nothing else in
 * the app would report it.
 *
 * The vectors, the sweep and the verdict live in `services/handle-fold-probe.ts` so the same code runs
 * here and under Node in `handle-fold-probe.test.ts`. That test pins the *expectations*; this screen
 * is what tells us whether Hermes agrees with them.
 *
 * ⚠️ Run this alongside the NFC probe, not instead of it. The sweep folds and composes in one call, so
 * a red sweep with a green NFC probe points at the fold, and both red points at Unicode data.
 *
 * Strings are inline English — dev-only screen.
 *
 * @module
 */

import {foldLengthChanges} from '@pnyx/contract-client/handle'
import {router} from 'expo-router'
import {useCallback, useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Button} from '../../../src/components/Buttons'
import {SafeAreaViewWrapper} from '../../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../../src/components/Typography'
import {
  type FoldSweep,
  type FoldVectorResult,
  type FoldVerdict,
  foldVerdict,
  runFoldSweep,
  runFoldVectors,
} from '../../../src/services/handle-fold-probe'

const hexList = (cps: readonly number[]): string =>
  cps.map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`).join(' ')

const VERDICT_COPY: Record<FoldVerdict, string> = {
  ok: 'Fold matches the reference on every allowed codepoint. Handle addresses derived here agree with every other engine.',
  'ascii-only':
    'THIS RUNTIME FOLDS ASCII ONLY — non-ASCII returned unchanged. Every accented, Cyrillic or mixed-case non-Latin name would derive the wrong address. Ship no non-ASCII handle until we carry our own case table.',
  diverges:
    'THE FOLD DISAGREES — the runtime has case data and does not match the reference. Names in the buckets below derive addresses this device alone can find. Do not bind a handle until it is understood.',
}

type Run = {
  readonly vectors: readonly FoldVectorResult[]
  readonly sweep: FoldSweep
  readonly lengthChanges: ReturnType<typeof foldLengthChanges>
  readonly ms: number
}

export default function HandleFoldProbeScreen() {
  const [run, setRun] = useState<Run | null>(null)
  const [running, setRunning] = useState(false)

  const start = useCallback(() => {
    setRunning(true)
    // The sweep is ~150k canonicalisations and blocks; yield once so the button's pressed state paints.
    setTimeout(() => {
      const started = Date.now()
      const vectors = runFoldVectors()
      const sweep = runFoldSweep()
      const lengthChanges = foldLengthChanges()
      setRun({vectors, sweep, lengthChanges, ms: Date.now() - started})
      setRunning(false)
    }, 0)
  }, [])

  const verdict = run ? foldVerdict(run.vectors, run.sweep) : null

  return (
    <SafeAreaViewWrapper style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <Typography variant="headingSm">Handle case-fold probe</Typography>
          <Typography variant="bodyXs_regular" style={styles.muted}>
            A handle's address derives from its folded bytes. If this runtime folds any allowed codepoint differently,
            that name is unreachable — and it looks like the name is simply free.
          </Typography>
        </View>

        <View style={styles.buttons}>
          <Button
            label={running ? 'Sweeping…' : 'Run vectors and sweep'}
            variant="secondary"
            onPress={start}
            disabled={running}
            fullWidth
          />
          <Button label="Back" variant="nakedDefault" onPress={() => router.back()} fullWidth />
        </View>

        {verdict !== null && run !== null && (
          <View style={[styles.entry, verdict !== 'ok' && styles.entryError]}>
            <Typography variant="bodySm_medium">Verdict: {verdict}</Typography>
            <Typography variant="bodyXs_regular" style={styles.muted}>
              {VERDICT_COPY[verdict]}
            </Typography>
            <Typography variant="bodyXs_regular" style={styles.muted}>
              {run.sweep.codePoints} codepoints across {run.sweep.buckets.length} buckets, {run.ms} ms
            </Typography>
          </View>
        )}

        {run !== null && run.sweep.diverged.length > 0 && (
          <View style={styles.entries}>
            {run.sweep.diverged.map((r) => (
              <View key={r.index} style={[styles.entry, styles.entryError]}>
                <Typography variant="bodySm_medium">
                  DIVERGED — bucket {r.index}: U+{r.first.toString(16).toUpperCase()} to U+
                  {r.last.toString(16).toUpperCase()} ({r.codePoints} codepoints)
                </Typography>
                <Typography variant="bodyXs_regular" style={styles.muted}>
                  want {r.expected ?? 'nothing pinned — the reference table is stale'}
                </Typography>
                <Typography variant="bodyXs_regular" style={styles.muted}>
                  got {r.digest}
                </Typography>
              </View>
            ))}
          </View>
        )}

        <View style={styles.entries}>
          {(run?.vectors ?? []).map((r) => (
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

        {run !== null && (
          <View style={styles.entries}>
            <Typography variant="bodySm_medium">Folds that change byte length: {run.lengthChanges.length}</Typography>
            <Typography variant="bodyXs_regular" style={styles.muted}>
              Mostly Indic and Tibetan, where NFC decomposes rather than composes. A different count here is a
              divergence, and length is what decides a name's price tier. First few:
            </Typography>
            {run.lengthChanges.slice(0, 8).map((c) => (
              <View key={c.codePoint} style={styles.entry}>
                <Typography variant="bodySm_medium">
                  U+{c.codePoint.toString(16).toUpperCase().padStart(4, '0')} — {c.fromBytes} to {c.toBytes} bytes
                </Typography>
                <Typography variant="bodyXs_regular" style={styles.muted}>
                  folds to {hexList([...c.to].map((ch) => ch.codePointAt(0) as number))}
                </Typography>
              </View>
            ))}
          </View>
        )}
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
