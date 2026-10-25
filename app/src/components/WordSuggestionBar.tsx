/**
 * WordSuggestionBar component.
 *
 * A horizontal bar of word suggestion pills anchored just above the keyboard.
 * Extracted from MnemonicInput for use as an external suggestion display.
 *
 * @module
 */

import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useI18n} from '../providers'
import {ChamferBackground} from './Chamfer'
import {Typography} from './Typography'
import {WarningMessage} from './WarningMessage'

type WordSuggestionBarProps = {
  suggestions: string[]
  currentWord: string
  onSelectSuggestion: (word: string) => void
}

const SuggestionPill = ({word, onPress}: {word: string; onPress: () => void}) => {
  return (
    <Pressable onPress={onPress} style={styles.pill}>
      <ChamferBackground size="auto" fillToken="primaryMuted" borderToken="primaryDefault" />
      <View style={styles.pillContainer}>
        <Typography variant="bodyMd_medium" style={styles.pillText}>
          {word}
        </Typography>
      </View>
    </Pressable>
  )
}

export const WordSuggestionBar = ({suggestions, currentWord, onSelectSuggestion}: WordSuggestionBarProps) => {
  const {t} = useI18n()
  const showNotFound = currentWord.length >= 2 && suggestions.length === 0
  const showContent = suggestions.length > 0 || showNotFound

  // Always render View to maintain stable native view reference for KeyboardStickyView
  return (
    <View style={showContent ? styles.container : styles.hiddenContainer}>
      {suggestions.length > 0 ? (
        <View style={styles.pillsRow}>
          {suggestions.map((word) => (
            <SuggestionPill key={word} word={word} onPress={() => onSelectSuggestion(word)} />
          ))}
        </View>
      ) : showNotFound ? (
        <View style={styles.notFoundContainer}>
          <WarningMessage variant="warning" label={t('onboarding.restore.wordNotFound')} />
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingHorizontal: theme.spacing.spacing16,
    paddingVertical: theme.spacing.spacing16,
  },
  hiddenContainer: {
    height: 0,
    overflow: 'hidden' as const,
  },
  pillsRow: {
    flexDirection: 'row' as const,
    gap: theme.spacing.spacing16,
  },
  pill: {
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
  },
  pillText: {
    color: theme.colors.primaryDefault,
  },
  notFoundContainer: {
    height: theme.spacing.spacing48,
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
  },
  pillContainer: {
    paddingHorizontal: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing6,
    flex: 1,
  },
}))
