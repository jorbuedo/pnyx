/**
 * MnemonicDisplay component.
 *
 * Displays a mnemonic phrase in a grid format with blur/reveal toggle.
 * Used during wallet creation to show the recovery phrase.
 *
 * Recovery-phrase word grid used by the create-wallet flow.
 *
 * @module
 */

import {BlurTargetView} from 'expo-blur'
import type {ComponentProps} from 'react'
import {useRef, useState} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet, useUnistyles} from 'react-native-unistyles'
import {useI18n} from '../providers'
import {androidSupportsBlur, BlurRevealOverlay} from './BlurRevealOverlay'
import {ChamferBackground} from './Chamfer'
import {Typography} from './Typography'
import {UniIcon} from './UniIcon'

export type MnemonicDisplayProps = {
  /** The mnemonic phrase as a string (space-separated words) */
  mnemonic: string
  /** Whether to show the phrase revealed by default */
  initiallyRevealed?: boolean
  /** Callback when reveal state changes */
  onRevealChange?: (revealed: boolean) => void
  /** Test ID prefix for e2e testing */
  testID?: string
}

/**
 * Eye icon for show/hide toggle.
 */
const EyeIcon = ({open}: {open: boolean}) => {
  return open ? (
    <UniIcon name="reveal" size="md" uniProps={(t) => ({color: t.colors.primaryDefault})} />
  ) : (
    <UniIcon name="hide" size="md" uniProps={(t) => ({color: t.colors.primaryDefault})} />
  )
}

/**
 * MnemonicDisplay component for showing recovery phrases.
 *
 * Features:
 * - Blurred by default for security
 * - Toggle to reveal/hide
 * - Word numbering for verification
 * - Responsive grid layout
 *
 * @example
 * ```tsx
 * <MnemonicDisplay
 *   mnemonic="word1 word2 word3 ... word24"
 *   onRevealChange={(revealed) => setCanProceed(revealed)}
 * />
 * ```
 */
export const MnemonicDisplay = ({
  mnemonic,
  initiallyRevealed = false,
  onRevealChange,
  testID = 'mnemonic',
}: MnemonicDisplayProps) => {
  const {t} = useI18n()
  const [isRevealed, setIsRevealed] = useState(initiallyRevealed)
  const blurTargetRef = useRef<View | null>(null)
  const words = mnemonic.split(' ')

  const handleToggle = () => {
    const newState = !isRevealed
    setIsRevealed(newState)
    onRevealChange?.(newState)
  }

  const {theme} = useUnistyles()
  // 15 = the ~8% alpha the badge surface has always used against the card.
  const wordBadgeFill = `${theme.colors.primaryDefault}15`

  const wordsGrid = (
    <View style={styles.wordsGrid}>
      {words.map((word, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Words are static mnemonic that never reorders
        <View key={`${testID}-word-${index}`} testID={`${testID}-word-${index}`} style={styles.wordBadge}>
          <ChamferBackground size="auto" fill={wordBadgeFill} />
          <Typography variant="bodySm_medium" style={styles.wordNumber}>
            {index + 1}.
          </Typography>
          <Typography variant="bodyMd_regular" style={styles.wordText} testID={`${testID}-word-${index}-text`}>
            {word}
          </Typography>
        </View>
      ))}
    </View>
  )

  return (
    <View style={styles.container} testID={testID}>
      {/* Word Grid */}
      <View style={styles.gridContainer}>
        {/* Words — wrapped in BlurTargetView on Android so the blur has a source.
            Keep wordsGrid on a real View elsewhere: Unistyles only resolves
            `style` on host components, not through the BlurTargetView wrapper. */}
        {androidSupportsBlur ? (
          // Cast: expo-blur is hoisted against the workspace-root react-native
          // types (0.86) while this app pins 0.83 — same host View at runtime.
          <BlurTargetView ref={blurTargetRef as unknown as NonNullable<ComponentProps<typeof BlurTargetView>['ref']>}>
            {wordsGrid}
          </BlurTargetView>
        ) : (
          wordsGrid
        )}

        {/* Blur overlay - only render when not revealed */}
        {!isRevealed && <BlurRevealOverlay blurTarget={blurTargetRef} />}
      </View>

      {/* Toggle Button */}
      <Pressable onPress={handleToggle} style={styles.toggleButton} testID={`${testID}-toggle-button`}>
        <EyeIcon open={!isRevealed} />
        <Typography variant="bodyMd_medium" style={styles.toggleText}>
          {isRevealed ? t('onboarding.create.revealToggle.hide') : t('onboarding.create.revealToggle.show')}
        </Typography>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing.spacing16,
  },
  gridContainer: {
    position: 'relative',
    overflow: 'hidden',
    borderRadius: theme.borderRadius.rounded12,
    backgroundColor: theme.colors.backgroundAlternative,
    padding: theme.spacing.spacing12,
  },
  wordsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.spacing8,
    paddingVertical: theme.spacing.spacing8,
  },
  wordBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing8,
    gap: theme.spacing.spacing4,
  },
  toggleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing8,
  },
  toggleText: {
    color: theme.colors.primaryDefault,
  },
  wordNumber: {
    color: theme.colors.primaryDefault,
    opacity: 0.7,
  },
  wordText: {
    color: theme.colors.primaryDefault,
  },
}))
