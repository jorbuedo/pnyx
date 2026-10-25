/**
 * PIN entry — the profile gate's only surface.
 *
 * **This screen must never indicate why it is showing.** Same title, same copy,
 * same layout whether it was triggered by a cold start, an every-unlock policy,
 * or a manual lock; and identical whichever profile the entered code goes on to
 * open. It is the one thing a coercer sees, so it carries no information about
 * the mode behind it — no "locked manually", no variant subtitle, no distinct
 * icon. `pin-entry-uniformity.test.ts` holds the line.
 *
 * @module
 */

import {useCallback, useRef, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {ChamferBackground} from '../components/Chamfer'
import {NumpadBase} from '../components/Numpad/NumpadBase'
import {SafeAreaViewWrapper} from '../components/SafeAreaViewWrapper'
import {Typography} from '../components/Typography'
import {UniIcon} from '../components/UniIcon'
import {useI18n} from '../providers/I18nProvider'

export type PinEntryScreenProps = {
  /** Digits expected before submission fires. */
  readonly length: number
  /** Resolve a completed code. Returns false to show the error line. */
  readonly onSubmit: (code: string) => Promise<boolean>
  /**
   * Replaces the heading. Used by the setup flows ("Choose a PIN", "Enter it
   * again"); the gate never passes one, so it always reads the same.
   */
  readonly title?: string | undefined
  /** Replaces the failure line. The gate never passes one. */
  readonly errorText?: string | undefined
  readonly testID?: string | undefined
}

export function PinEntryScreen({length, onSubmit, title, errorText, testID}: PinEntryScreenProps) {
  const {t} = useI18n()
  /**
   * The entered digits, held in a ref as well as state.
   *
   * The ref is the source of truth for accumulation. Reading the state value in
   * the key handler loses digits: taps arrive faster than React commits, so a
   * handler closed over a stale `code` computes the same `next` twice and one
   * press vanishes — the field would sit at five of six and never submit. A ref
   * updates synchronously, and the state copy exists only to drive the dots.
   */
  const codeRef = useRef('')
  const [code, setCode] = useState('')
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)

  const submit = useCallback(
    async (value: string) => {
      setBusy(true)
      const ok = await onSubmit(value)
      // Cleared either way. On failure that is the retry; on success the gate
      // unmounts immediately, but the multi-pass setup flow stays mounted and
      // needs an empty field for its next pass.
      codeRef.current = ''
      setCode('')
      setError(!ok)
      setBusy(false)
    },
    [onSubmit],
  )

  const handleKey = useCallback(
    (key: string) => {
      if (busy || codeRef.current.length >= length) return
      const next = codeRef.current + key
      codeRef.current = next
      setError(false)
      setCode(next)
      if (next.length === length) void submit(next)
    },
    [busy, length, submit],
  )

  const handleBackspace = useCallback(() => {
    if (busy) return
    codeRef.current = codeRef.current.slice(0, -1)
    setError(false)
    setCode(codeRef.current)
  }, [busy])

  return (
    <SafeAreaViewWrapper style={styles.safeArea} edges={['top', 'bottom']} testID={testID}>
      <View style={styles.container}>
        <View style={styles.head}>
          <View style={styles.iconBadge}>
            <ChamferBackground size="auto" fillToken="primaryMuted" />
            <UniIcon name="lock" width={28} height={28} uniProps={(theme) => ({color: theme.colors.primaryDefault})} />
          </View>
          {/* One line, not two: a heading plus a subtitle both saying "enter
              your PIN" said the same thing twice. The setup flows replace this
              heading rather than adding a second line under it. */}
          <Typography variant="headingMd" style={styles.title}>
            {title ?? t('lock.pin.title')}
          </Typography>
        </View>

        <View style={styles.dots} accessibilityLabel={t('lock.pin.dotsAccessibilityLabel', {count: code.length})}>
          {Array.from({length}, (_, i) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length positional dots, never reordered
              key={i}
              style={[styles.dot, i < code.length && styles.dotFilled]}
            >
              {i >= code.length && <View style={styles.dotHole} />}
            </View>
          ))}
        </View>

        {/* The failure lives in this line alone. Recolouring the dots as well made
            a cleared field read as still full, and the count is what the dots are
            for. */}
        <Typography variant="bodySm_regular" style={styles.error}>
          {error ? (errorText ?? t('lock.pin.wrong')) : ' '}
        </Typography>

        <NumpadBase
          onKeyPress={handleKey}
          onBackspace={handleBackspace}
          showDecimal={false}
          isDisabled={busy}
          testID="pin-numpad"
        />
      </View>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {
    flex: 1,
    backgroundColor: theme.colors.backgroundDefault,
  },
  container: {
    flex: 1,
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.spacing24,
    paddingBottom: theme.spacing.spacing24,
  },
  head: {
    alignItems: 'center',
    gap: theme.spacing.spacing12,
    paddingTop: theme.spacing.spacing48,
  },
  iconBadge: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    textAlign: 'center',
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: theme.spacing.spacing16,
  },
  /**
   * An empty dot is a ring built from two solid fills, not a border.
   *
   * `borderWidth` + `borderRadius` + a transparent background rendered as a
   * barely-visible *square* on this build's Fabric renderer, and on some devices
   * did not paint at all — the field looked like it had no dots until a digit
   * filled one in. Two concentric solid discs give the same ring with none of
   * that fragility: the outer disc is the ring colour, the inner one punches the
   * page background back out. A filled dot simply omits the inner disc.
   */
  dot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.borderDefaultStrong,
  },
  dotHole: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: theme.colors.backgroundDefault,
  },
  dotFilled: {
    backgroundColor: theme.colors.primaryDefault,
  },
  error: {
    textAlign: 'center',
    color: theme.colors.errorDefault,
  },
}))
