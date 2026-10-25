/**
 * 12 / 15 / 24 segmented selector for the recovery-phrase grid.
 *
 * Selection is `primary`, not `info`. A word count is not an informational state — it is what the
 * user picked — and `infoDefault` is a blue that appears nowhere else in this flow, so it read as a
 * different app's accent sitting in the middle of a Pnyx screen.
 *
 * @module
 */

import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {useI18n} from '../../providers'
import {type MnemonicWordCount, VALID_MNEMONIC_WORD_COUNTS} from '../../utils/mnemonic'
import {ChamferBackground} from '../Chamfer'
import {Typography} from '../Typography'

const SEGMENT_ROW_HEIGHT_PX = 38

export type RecoveryWordCountSelectorProps = {
  wordCount: MnemonicWordCount
  onChange: (count: MnemonicWordCount) => void
}

export const RecoveryWordCountSelector = ({wordCount, onChange}: RecoveryWordCountSelectorProps) => {
  const {t} = useI18n()
  return (
    <View style={styles.segmented}>
      <ChamferBackground
        size="auto"
        fillToken="backgroundAlternativeHover"
        borderToken="borderSubtle"
        borderWidth={1}
      />
      {VALID_MNEMONIC_WORD_COUNTS.map((count) => {
        const selected = wordCount === count
        return (
          <Pressable
            key={count}
            onPress={() => onChange(count)}
            style={styles.segment}
            testID={`recovery-word-count-${count}`}
          >
            {selected && (
              <ChamferBackground size="auto" fillToken="primaryMuted" borderToken="primaryDefault" borderWidth={1} />
            )}
            <Typography variant="bodyMd_medium" style={[styles.segmentText(selected)]}>
              {t('onboarding.recovery.wordCount', {count})}
            </Typography>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  segmented: {
    flexDirection: 'row',
    gap: theme.spacing.spacing6,
    padding: theme.spacing.spacing4,
  },
  segment: {
    flex: 1,
    height: SEGMENT_ROW_HEIGHT_PX,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentText: (selected: boolean) => ({
    color: selected ? theme.colors.primaryDefault : theme.colors.textAlternative,
  }),
}))
