/**
 * Shared mnemonic verification components.
 *
 * Extracted from the onboarding verify screen for reuse in
 * the settings backup verification flow.
 *
 * @module
 */

import {Pressable, View} from 'react-native'
import {StyleSheet, useUnistyles} from 'react-native-unistyles'

import {useI18n} from '../providers'
import {ChamferBackground} from './Chamfer'
import {Typography} from './Typography'

export type WordEntry = {
  id: number
  word: string
}

/**
 * Selected words input area.
 */
export const SelectedWordsArea = ({
  selectedEntries,
  expectedOrder,
  onRemoveLast,
}: {
  selectedEntries: WordEntry[]
  expectedOrder: WordEntry[]
  onRemoveLast: () => void
}) => {
  const {t} = useI18n()
  const {theme} = useUnistyles()
  const isComplete = selectedEntries.length === expectedOrder.length
  const isCorrect = isComplete && selectedEntries.every((entry, index) => entry.word === expectedOrder[index]?.word)

  const lastEntry = selectedEntries[selectedEntries.length - 1]
  const isLastWordCorrect = lastEntry && expectedOrder[selectedEntries.length - 1]?.word === lastEntry.word

  return (
    <View style={selectedStyles.container}>
      <ChamferBackground
        size="auto"
        fill={theme.colors.backgroundAlternative}
        borderColor={theme.colors.borderDefaultWeak}
        borderWidth={1}
      />
      <View style={selectedStyles.wordsContainer}>
        {selectedEntries.map((entry, index) => {
          const isLast = index === selectedEntries.length - 1
          const isWrong = isLast && !isLastWordCorrect

          return (
            <View key={`selected-${entry.id}-${index}`}>
              <Pressable
                onPress={isWrong ? onRemoveLast : undefined}
                disabled={!isWrong}
                style={selectedStyles.wordBadge}
              >
                <ChamferBackground
                  size="auto"
                  fill={
                    isWrong
                      ? `${theme.colors.errorDefault}15`
                      : isComplete && isCorrect
                        ? `${theme.colors.successDefault}15`
                        : `${theme.colors.primaryDefault}15`
                  }
                />
                <Typography
                  variant="bodySm_medium"
                  style={[selectedStyles.wordIndex, isWrong && selectedStyles.wordIndexError]}
                >
                  {index + 1}.
                </Typography>
                <Typography
                  variant="bodyMd_regular"
                  style={[
                    selectedStyles.wordText,
                    isWrong && selectedStyles.wordTextError,
                    isComplete && isCorrect && selectedStyles.wordTextSuccess,
                  ]}
                >
                  {entry.word}
                </Typography>
              </Pressable>
            </View>
          )
        })}
      </View>

      {/* Status messages */}
      {selectedEntries.length > 0 && !isLastWordCorrect && (
        <View style={selectedStyles.errorContainer}>
          <Typography variant="bodySm_regular" style={selectedStyles.errorText}>
            {t('onboarding.verify.incorrectWord')}
          </Typography>
        </View>
      )}
      {isComplete && isCorrect && (
        <View style={selectedStyles.successContainer}>
          <Typography variant="bodySm_medium" style={selectedStyles.successText}>
            {t('onboarding.verify.verified')}
          </Typography>
        </View>
      )}
    </View>
  )
}

const selectedStyles = StyleSheet.create((theme) => ({
  container: {
    padding: theme.spacing.spacing12,
    minHeight: 180,
  },
  wordsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.spacing8,
  },
  wordBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.spacing8,
    paddingVertical: theme.spacing.spacing4,
    gap: theme.spacing.spacing4,
  },
  wordIndex: {
    color: theme.colors.primaryDefault,
    opacity: 0.7,
  },
  wordIndexError: {
    color: theme.colors.errorDefault,
  },
  wordText: {
    color: theme.colors.primaryDefault,
  },
  wordTextError: {
    color: theme.colors.errorDefault,
  },
  wordTextSuccess: {
    color: theme.colors.successDefault,
  },
  errorContainer: {
    paddingTop: theme.spacing.spacing12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing8,
  },
  errorText: {
    color: theme.colors.errorDefault,
  },
  successContainer: {
    paddingTop: theme.spacing.spacing12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing8,
  },
  successText: {
    color: theme.colors.successDefault,
  },
}))

/**
 * Word selection badges (shuffled words to choose from).
 */
export const WordSelectionArea = ({
  shuffledEntries,
  selectedEntries,
  expectedOrder,
  onSelectWord,
  onReplaceLastWord,
}: {
  shuffledEntries: WordEntry[]
  selectedEntries: WordEntry[]
  expectedOrder: WordEntry[]
  onSelectWord: (entry: WordEntry) => void
  onReplaceLastWord: (entry: WordEntry) => void
}) => {
  const {theme} = useUnistyles()
  const isWordUsed = (entryId: number) => selectedEntries.some((entry) => entry.id === entryId)

  const lastEntry = selectedEntries[selectedEntries.length - 1]
  const isLastWordCorrect = !lastEntry || expectedOrder[selectedEntries.length - 1]?.word === lastEntry.word

  const handleSelect = (entry: WordEntry) => {
    if (isLastWordCorrect || selectedEntries.length === 0) {
      onSelectWord(entry)
    } else {
      onReplaceLastWord(entry)
    }
  }

  return (
    <View style={selectionStyles.container}>
      {shuffledEntries.map((entry) => {
        const isUsed = isWordUsed(entry.id)
        const isWrongSelection = !isLastWordCorrect && lastEntry?.id === entry.id

        return (
          <View key={`selection-${entry.id}`}>
            <Pressable
              onPress={() => handleSelect(entry)}
              disabled={isUsed}
              testID={isUsed ? `used-word-${entry.id}` : `word-${entry.id}`}
              style={selectionStyles.wordBadge}
            >
              <ChamferBackground
                size="auto"
                fill={
                  isWrongSelection
                    ? `${theme.colors.errorDefault}15`
                    : isUsed
                      ? theme.colors.backgroundDefault
                      : `${theme.colors.backgroundDefault}45`
                }
                borderColor={isWrongSelection ? theme.colors.errorDefault : `${theme.colors.primaryDefault}30`}
                borderWidth={2}
                borderDashed={isUsed && !isWrongSelection}
              />
              <Typography
                variant="bodyMd_regular"
                style={[
                  selectionStyles.wordText,
                  isUsed && selectionStyles.wordTextUsed,
                  isWrongSelection && selectionStyles.wordTextWrong,
                ]}
              >
                {entry.word}
              </Typography>
            </Pressable>
          </View>
        )
      })}
    </View>
  )
}

const selectionStyles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.spacing8,
  },
  wordBadge: {
    paddingHorizontal: theme.spacing.spacing16,
    paddingVertical: theme.spacing.spacing8,
  },
  wordText: {
    color: theme.colors.primaryDefault,
  },
  wordTextUsed: {
    color: theme.colors.textMuted,
  },
  wordTextWrong: {
    color: theme.colors.errorDefault,
  },
}))
