/**
 * The amount editor, for every rail: a big centred figure with an optional fiat line, the balance
 * it is a share of, and 25/50/75/Max chips.
 *
 * One implementation because typing an amount is one thing, however many recipients, wallets or
 * chains are involved. What differs between rails is *data* (ticker, decimals, what "available"
 * means, whether a price source exists) and what pressing the CTA commits to — so those are props.
 * Cardano's basket editor and the Midnight rail's single amount are both this screen.
 *
 * `available: null` is a withheld figure, not zero: a co-funder's balance that has not been read,
 * or a shielded Midnight balance whose coin core has not synced. Printing "Available 0" would tell
 * a funded wallet it cannot pay, so the line and the chips are hidden instead — a chip must never
 * take a percentage of a number nobody has confirmed.
 *
 * @module
 */

import {useState} from 'react'
import {Text, View} from 'react-native'
import {StyleSheet, withUnistyles} from 'react-native-unistyles'

import {Button} from '../../components/Buttons/Button'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {StickyFooter} from '../../components/StickyFooter'
import {TextInputBase} from '../../components/TextInputBase'
import {Typography} from '../../components/Typography'
import {useFormat, useI18n, useNumberParser} from '../../providers'
import {canonicalToDecimal} from './canonical-decimal'

const PCTS = [25, 50, 75] as const

/**
 * What the Max chip means on this rail.
 *
 * `sendAll` is Cardano's: a *flag* the build resolves later, because the spendable amount depends
 * on a fee that depends on the inputs. `balance` is the plain figure — right where the fee is not
 * taken from this balance at all, as on Midnight, where it is DUST somebody else pays. `none` hides
 * the chip.
 */
export type MaxMode = 'sendAll' | 'balance' | 'none'

export type AmountEditorProps = {
  /** Ticker or token label shown above the figure. */
  readonly label: string
  readonly decimals: number
  /** The balance the chips are a share of. `null` withholds it — see the module note. */
  readonly available: bigint | null
  /** The figure to open on. */
  readonly initial: bigint
  /** Open in send-all state (`sendAll` mode only). */
  readonly initialIsMax?: boolean
  /** Fiat for the typed amount, or null where the rail has no price source. */
  readonly fiat?: ((canonical: bigint) => {readonly value: number; readonly currency: string} | null) | undefined
  readonly maxMode?: MaxMode
  readonly ctaLabel: string
  readonly ctaBusy?: boolean
  /** `isMax` is only ever true under `maxMode: 'sendAll'`. */
  readonly onCommit: (quantity: bigint, isMax: boolean) => void
  /** Allow committing an empty figure (Cardano's ADA row keeps a zero). */
  readonly allowEmptyCommit?: boolean
  /**
   * Refuse an amount above `available`, with this message.
   *
   * Opt-in because the rails differ on *where* the refusal belongs. Cardano lets the figure through
   * and validates at review, which is deliberate: its balance is not the spendable amount (the fee
   * comes out of the same ADA), so the honest check needs the built transaction and a message about
   * min-ada or fees. Midnight's fee is DUST somebody else pays, so the balance *is* the ceiling and
   * the field that caused the problem is the place to say so.
   */
  readonly overspendMessage?: string
  /** Suffix for this editor's testIDs, so two rails' elements stay distinguishable. */
  readonly testIDKey: string
}

const styles = StyleSheet.create(({spacing, colors, fontSizes, fontFamily}) => ({
  content: {padding: spacing.spacing16, gap: spacing.spacing16, flexGrow: 1, justifyContent: 'center'},
  ticker: {color: colors.textMuted, textAlign: 'center', textTransform: 'uppercase', letterSpacing: 0.7},
  amountHero: {alignItems: 'center', gap: spacing.spacing2},
  amountInputWrap: {alignSelf: 'stretch'},
  /**
   * The placeholder zero, drawn so the caret lands *after* it rather than through it.
   *
   * The field is full-width and centre-aligned, so an empty value puts the caret at the
   * horizontal centre — exactly where a centred placeholder draws, and the two overlapped.
   *
   * Getting this right took two wrong turns worth recording. Right-aligning the zero in a
   * half-width box does put the caret after it, but then `0|` *as a pair* sits half a digit
   * left of centre, which reads as misaligned. What looks correct is the zero centred with
   * the caret at its right edge — exactly where they land once you actually type a `0`.
   *
   * So: the zero is centred, and the field takes `paddingLeft` equal to the digit's width.
   * With `textAlign: center` a left pad shifts the content box, moving the empty caret
   * right by *half* the pad — landing it on the centred zero's right edge. The width is
   * measured rather than guessed, so it holds at any font size or family.
   */
  placeholderLayer: {...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center'},
  placeholderZero: {
    fontSize: fontSizes.displayLg,
    fontFamily: fontFamily.semiBold,
    color: colors.textAlternative,
    paddingVertical: spacing.spacing4,
  },
  amountInput: {
    fontSize: fontSizes.displayLg,
    fontFamily: fontFamily.semiBold,
    textAlign: 'center',
    color: colors.textDefault,
    backgroundColor: 'transparent',
    borderWidth: 0,
    paddingVertical: spacing.spacing4,
  },
  fiat: {color: colors.textMuted},
  available: {color: colors.textMuted, textAlign: 'center'},
  pctRow: {flexDirection: 'row', gap: spacing.spacing8},
  pctBtn: {flex: 1},
  note: {color: colors.textMuted, textAlign: 'center'},
  error: {color: colors.errorDefault, textAlign: 'center'},
}))

/**
 * The amount hero is a bare centered figure, not the boxed floating-label
 * TextInput — so it drops to TextInputBase, with the placeholder colour themed
 * here (a prop, not a style) rather than reading the theme at render.
 */
const AmountInput = withUnistyles(TextInputBase, (theme) => ({
  placeholderTextColor: theme.colors.textAlternative,
}))

export const AmountEditor = ({
  label,
  decimals,
  available,
  initial,
  initialIsMax = false,
  fiat,
  maxMode = 'none',
  ctaLabel,
  ctaBusy = false,
  onCommit,
  allowEmptyCommit = false,
  overspendMessage,
  testIDKey,
  children,
}: AmountEditorProps & {readonly children?: React.ReactNode}) => {
  const {t} = useI18n()
  const format = useFormat()
  const parseNumber = useNumberParser()

  const [text, setText] = useState(() => (initial > 0n ? canonicalToDecimal(initial, decimals) : ''))
  const [isMax, setIsMax] = useState(() => initialIsMax && maxMode === 'sendAll')

  /** Empty and not showing a Max figure: ours to draw, not the platform's. */
  const showPlaceholder = text === '' && !isMax
  /** The placeholder digit's width, measured — see `placeholderLayer`. */
  const [zeroWidth, setZeroWidth] = useState(0)

  const parsed = parseNumber(text, {decimals})
  const quantity = parsed.isEmpty ? 0n : parsed.canonical
  const fiatValue = fiat === undefined || parsed.isEmpty ? null : fiat(quantity)
  const overspend = overspendMessage !== undefined && available !== null && quantity > available

  const onText = (value: string) => {
    setIsMax(false)
    setText(value)
  }

  const setPct = (pct: number) => {
    if (available === null) return
    setIsMax(false)
    setText(canonicalToDecimal((available * BigInt(pct)) / 100n, decimals))
  }

  return (
    <SafeAreaViewWrapper
      edges={['bottom']}
      scrollable
      // The content is centred in the viewport, so without this it keeps its resting height and
      // the raised footer lands on the figure and the percentage row — the two things this screen
      // is for. Safe here because nothing below pairs its own keyboard-avoiding view.
      contentAvoidsKeyboard
      contentContainerStyle={styles.content}
      stickyFooter={
        <StickyFooter>
          <Button
            label={ctaLabel}
            onPress={() => onCommit(quantity, isMax)}
            fullWidth
            size="xl"
            isLoading={ctaBusy}
            isDisabled={ctaBusy || overspend || (!isMax && parsed.isEmpty && !allowEmptyCommit)}
            testID={`send-amount-commit-${testIDKey}`}
          />
        </StickyFooter>
      }
    >
      <Typography variant="bodySm_medium" style={styles.ticker}>
        {label}
      </Typography>

      <View style={styles.amountHero}>
        <View style={styles.amountInputWrap}>
          {/* Empty and not showing a Max figure: the zero is ours to place, not the
              platform's. `pointerEvents="none"` so a tap still lands on the field. */}
          {showPlaceholder ? (
            <View style={styles.placeholderLayer} pointerEvents="none">
              <Text style={styles.placeholderZero} onLayout={(e) => setZeroWidth(e.nativeEvent.layout.width)}>
                0
              </Text>
            </View>
          ) : null}
          <AmountInput
            value={
              isMax && available !== null ? format(available, {preset: 'cryptoBalance', decimals}) : parsed.inputValue
            }
            onChangeText={onText}
            editable={!isMax}
            keyboardType="decimal-pad"
            textAlign="center"
            autoFocus
            style={[styles.amountInput, showPlaceholder ? {paddingLeft: zeroWidth} : null]}
            testID={`send-amount-${testIDKey}`}
          />
        </View>
        {fiatValue !== null ? (
          <Typography variant="bodySm_regular" style={styles.fiat}>
            {format(fiatValue.value, {preset: 'fiatBalance', currency: fiatValue.currency})}
          </Typography>
        ) : null}
        {available !== null ? (
          <Typography variant="bodyXs_regular" style={styles.available}>
            {t('cardanoSend.available', {
              amount: format(available, {preset: 'cryptoBalance', currency: label, decimals}),
            })}
          </Typography>
        ) : null}
        {overspend ? (
          <Typography variant="bodyXs_regular" style={styles.error}>
            {overspendMessage}
          </Typography>
        ) : null}
      </View>

      {/* Percentages and Max are percentages *of the balance shown* — withheld while it is
          unread, so a chip never computes against a number nobody confirmed. */}
      {available === null ? null : (
        <View style={styles.pctRow}>
          {PCTS.map((pct) => (
            <Button
              key={pct}
              label={t('cardanoSend.percent', {value: pct})}
              variant="secondary"
              size="sm"
              containerStyles={styles.pctBtn}
              onPress={() => setPct(pct)}
              testID={`send-pct-${testIDKey}-${pct}`}
            />
          ))}
          {maxMode === 'none' ? null : (
            <Button
              label={t('cardanoSend.max')}
              variant={isMax ? 'primary' : 'secondary'}
              size="sm"
              containerStyles={styles.pctBtn}
              onPress={() => {
                if (maxMode === 'balance') {
                  setIsMax(false)
                  setText(canonicalToDecimal(available, decimals))
                  return
                }
                setIsMax((m) => !m)
              }}
              testID={`send-max-${testIDKey}`}
            />
          )}
        </View>
      )}

      {/* Anything a rail needs to say about this figure — the Midnight rail names which of its
          two rails the recipient's address chose, because they cost different amounts of time. */}
      {children === undefined ? null : <View style={styles.amountHero}>{children}</View>}
    </SafeAreaViewWrapper>
  )
}
