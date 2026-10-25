/**
 * Search-engine picker bottom sheet.
 *
 * Opened from `BrowserMenuSheet`. Built on the shared cross-
 * platform `<Modal position="bottom">` so it renders correctly on iOS /
 * Android / web / extension popup / extension fullscreen — the modal owns
 * animations (reanimated), backdrop, drag-to-dismiss on mobile, and
 * safe-area insets, so this file only owns the row content.
 *
 * Card-row layout: 36px branded logo tile + name + subtitle, full-width
 * card. Selected state = accent-coloured border + tinted background; no
 * checkmark (no radio toggle).
 *
 * @module
 */

import {Pressable, ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useI18n} from '../../providers'
import {type BrowserSearchEngine, SEARCH_ENGINES} from '../../services/browser-prefs-storage'
import {ChamferBackground} from '../Chamfer'
import {Modal} from '../Modal'
import {Typography} from '../Typography'
import {SearchEngineLogo} from './SearchEngineLogo'

type SearchEnginePickerSheetProps = {
  visible: boolean
  selected: BrowserSearchEngine
  onSelect: (engine: BrowserSearchEngine) => void
  onClose: () => void
}

export const SearchEnginePickerSheet = ({visible, selected, onSelect, onClose}: SearchEnginePickerSheetProps) => {
  const {t} = useI18n()

  return (
    <Modal
      visible={visible}
      onClose={onClose}
      position="bottom"
      title={t('browser.settings.searchEngine')}
      showDragIndicator
      contentContainerStyle={styles.modalContent}
      testID="browser-settings-search-engine-sheet"
    >
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
        {SEARCH_ENGINES.map((engine) => {
          const isSelected = engine === selected
          return (
            <Pressable
              key={engine}
              onPress={() => onSelect(engine)}
              style={styles.option}
              accessibilityRole="radio"
              accessibilityState={{selected: isSelected}}
              testID={`browser-settings-search-engine-option-${engine}`}
            >
              <ChamferBackground
                size="auto"
                fillToken={isSelected ? 'accentMuted' : 'backgroundAlternative'}
                borderToken={isSelected ? 'primaryDefault' : 'borderDefaultWeak'}
                borderWidth={1}
              />
              <SearchEngineLogo engine={engine} />
              <View style={styles.info}>
                <Typography variant="bodyMd_bold" style={styles.name}>
                  {t(`browser.searchEngines.${engine}`)}
                </Typography>
                <Typography variant="bodyXs_regular" style={styles.sub}>
                  {t(`browser.searchEngineSubtitles.${engine}`)}
                </Typography>
              </View>
            </Pressable>
          )
        })}
      </ScrollView>
    </Modal>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  modalContent: {
    paddingHorizontal: spacing.spacing16,
    paddingTop: spacing.spacing4,
  },
  list: {
    maxHeight: 480,
  },
  listContent: {
    gap: spacing.spacing8,
    paddingBottom: spacing.spacing8,
  },
  // 12×14 padding, 12 gap, card bg, subtle border, lg radius.
  option: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: spacing.spacing12,
    paddingVertical: spacing.spacing12,
    paddingHorizontal: spacing.spacing16,
  },
  info: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    color: colors.textDefault,
  },
  sub: {
    color: colors.textAlternative,
    marginTop: 2,
  },
}))
