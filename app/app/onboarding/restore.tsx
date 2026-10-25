/**
 * Restore Wallet Screen.
 *
 * Lets the user enter their BIP-39 recovery phrase using a per-word grid.
 *
 * - "Enter recovery phrase" title.
 * - 12 / 15 / 24 word-count selector.
 * - Numbered word inputs in a 3-column grid.
 * - BIP-39 word suggestions (sticky bar) while typing.
 * - Paste a full phrase into any field to distribute across the grid.
 * - "Restore wallet" CTA at the bottom (sticky to the keyboard).
 *
 * Input mechanics (state, handlers, validation, paste distribution, etc.)
 * live in `useRecoveryPhraseInput`; the per-cell view is `<RecoveryWordCell>`.
 * This file is the layout + submit-orchestration shell.
 *
 * @module
 */

import {useFocusEffect} from 'expo-router'
import {useCallback, useRef, useState} from 'react'
import {View} from 'react-native'
import {KeyboardAwareScrollView, KeyboardStickyView} from 'react-native-keyboard-controller'
import {useSafeAreaInsets} from 'react-native-safe-area-context'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../src/components/Buttons'
import {RecoveryPhraseStatus} from '../../src/components/onboarding/RecoveryPhraseStatus'
import {RecoveryWordCell} from '../../src/components/onboarding/RecoveryWordCell'
import {RecoveryWordCountSelector} from '../../src/components/onboarding/RecoveryWordCountSelector'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../src/components/Typography'
import {WordSuggestionBar} from '../../src/components/WordSuggestionBar'
import {useGuardedNavigation} from '../../src/hooks/useGuardedNavigation'
import {useOnboardingAuthNavigation} from '../../src/hooks/useOnboardingAuthNavigation'
import {useRecoveryPhraseInput} from '../../src/hooks/useRecoveryPhraseInput'
import {logger} from '../../src/logger'
import {useI18n, useOnboarding} from '../../src/providers'

/** Floor for the scroll reserve, matching what `scrollContent` sets before the footer is measured. */
const STATIC_FOOTER_RESERVE_PX = 104

// Passkey-PRF recovery rail lands here (see docs/mobile-shell-plan.md phase 2):
// the mnemonic entered below will be re-derivable from a synced passkey's PRF
// output, making this manual-entry screen one of two restore paths.
export default function RestoreWalletScreen() {
  const {t} = useI18n()
  const insets = useSafeAreaInsets()
  const {setMnemonic: setOnboardingMnemonic, setIsRestore} = useOnboarding()
  const {navigateToAuthSetup} = useOnboardingAuthNavigation()
  const navigationGuard = useGuardedNavigation()

  const recovery = useRecoveryPhraseInput()
  /**
   * How much room the sticky footer needs, and it must cover the **whole** footer — CTA and
   * suggestion bar together. Reserving only the CTA looks right with the keyboard closed and fails
   * the moment it opens: `KeyboardStickyView` lifts the footer over the grid, and the CTA lands on
   * top of the last row and the tip.
   *
   * ⚠️ **Grow-only.** The suggestion bar comes and goes on every keystroke, so a reserve that
   * tracked the live height would shift the grid under the user's fingers as they type. Taking the
   * maximum means it expands once, the first time suggestions appear, and never moves again.
   */
  const [footerHeight, setFooterHeight] = useState<number | null>(null)
  const noteFooterHeight = useCallback((height: number) => {
    setFooterHeight((current) => (current === null || height > current ? height : current))
  }, [])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const isSubmittingRef = useRef(false)

  useFocusEffect(
    useCallback(() => {
      isSubmittingRef.current = false
      setIsSubmitting(false)
    }, []),
  )

  const handleNavigate = useCallback(
    (phrase: string) => {
      navigationGuard.guard(async () => {
        try {
          setOnboardingMnemonic(phrase)
          setIsRestore(true)
          await navigateToAuthSetup()
          // Keep loading state active after successful navigation — the
          // spinner stays visible until this screen unmounts or the user
          // navigates back (which re-mounts with fresh state).
        } catch (e: unknown) {
          // The user is returned to the form with no message, so a restore that failed and one
          // they abandoned look the same from here.
          logger.warn('Restore could not proceed to auth setup', {origin: 'restore', error: String(e)})
          // Release the outer submitting guard + the inner navigation guard
          // so the user can retry from a clean state.
          isSubmittingRef.current = false
          setIsSubmitting(false)
          navigationGuard.reset()
        }
      })
    },
    [setOnboardingMnemonic, setIsRestore, navigateToAuthSetup, navigationGuard],
  )

  const handleImport = useCallback(async () => {
    if (isSubmittingRef.current) return
    const phrase = recovery.attemptSubmit()
    if (phrase == null) return
    isSubmittingRef.current = true
    setIsSubmitting(true)
    // Allow UI to render loading state before the navigation push.
    await new Promise((resolve) => setTimeout(resolve, 200))
    await handleNavigate(phrase)
  }, [recovery.attemptSubmit, handleNavigate])

  return (
    <SafeAreaViewWrapper style={styles.safeArea} edges={[]} noPadding>
      <KeyboardAwareScrollView
        bottomOffset={footerHeight ?? 200}
        contentContainerStyle={[
          styles.scrollContent,
          // Never *less* than the static reserve below — the measured footer is smaller than the old
          // guess when no suggestions are showing, so taking it alone would shrink the clearance.
          footerHeight === null ? null : {paddingBottom: Math.max(footerHeight, STATIC_FOOTER_RESERVE_PX)},
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={64}
      >
        <View style={styles.header}>
          <Typography variant="headingXl" style={styles.title}>
            {t('onboarding.recovery.title')}
          </Typography>
          <Typography variant="bodyMd_regular" style={styles.subtitle}>
            {t('onboarding.recovery.subtitle')}
          </Typography>
        </View>

        <RecoveryWordCountSelector wordCount={recovery.wordCount} onChange={recovery.handleWordCountChange} />

        <View style={styles.grid}>
          {recovery.words.map((word, index) => (
            <RecoveryWordCell
              key={`word-${recovery.wordCount}-${index}`}
              index={index}
              value={word}
              hasError={recovery.cellErrors[index] === 'invalidWord'}
              autoFocus={index === 0}
              onChange={(value) => recovery.handleWordChange(index, value)}
              onFocus={() => recovery.handleCellFocus(index)}
              onBlur={() => recovery.handleCellBlur(index)}
              onSubmit={() => recovery.handleCellSubmit(index)}
              onKeyPress={(e) => recovery.handleCellKeyPress(index, e)}
              registerRef={recovery.registerRef(index)}
              testID={`recovery-word-${index + 1}`}
            />
          ))}
        </View>

        <RecoveryPhraseStatus
          cellErrors={recovery.cellErrors}
          submitError={recovery.submitError}
          pasteNotice={recovery.pasteNotice}
        />
      </KeyboardAwareScrollView>
      <KeyboardStickyView offset={{closed: 0, opened: 20}}>
        <View
          // ⚠️ The bottom inset lives here, not on the button. The button is conditional, so hanging
          // the padding off it left the suggestion bar flush against the keyboard whenever it was
          // the only thing in the footer.
          style={[styles.stickyFooter, {paddingBottom: Math.max(insets.bottom, 24)}]}
          onLayout={(event) => noteFooterHeight(event.nativeEvent.layout.height)}
        >
          <WordSuggestionBar
            suggestions={recovery.showSuggestions ? recovery.suggestions : []}
            currentWord={recovery.showSuggestions ? recovery.currentWord : ''}
            onSelectSuggestion={recovery.handleSelectSuggestion}
          />

          {/* ⚠️ **Absent until it can be pressed**, not disabled-and-floating. While the phrase is
              being typed the keyboard is up and this footer sits over the grid, so a button nobody
              can press was occluding the last row and the tip to say nothing. What belongs above a
              keyboard is the suggestion bar. `RecoveryPhraseStatus` carries the reason a phrase is
              not yet accepted, so nothing is lost by the button being away. */}
          {recovery.canSubmit || isSubmitting ? (
            <View style={styles.buttonContainer}>
              <Button
                label={t('onboarding.recovery.restoreButton')}
                fullWidth
                size="xl"
                onPress={handleImport}
                isLoading={isSubmitting}
                testID="restore-import-button"
              />
            </View>
          ) : null}
        </View>
      </KeyboardStickyView>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme, rt) => ({
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: theme.spacing.spacing16,
    gap: theme.spacing.spacing16,
    paddingTop: theme.spacing.spacing16,
    // Replaced at runtime by the measured CTA height; this is only the first-paint reserve.
    paddingBottom: theme.spacing.spacing104 + rt.insets.bottom,
  },
  header: {
    gap: theme.spacing.spacing8,
  },
  title: {
    color: theme.colors.textDefault,
  },
  subtitle: {
    color: theme.colors.textAlternative,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: theme.spacing.spacing8,
  },
  buttonContainer: {
    paddingHorizontal: theme.spacing.spacing16,
  },
  stickyFooter: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
}))
