/**
 * Wallet-identity ("Show as") picker bottom sheet.
 *
 * Chooses which wallet an injected provider claims to be, for dApps that gate their connect button
 * on a specific wallet rather than taking whatever is in the registry. One component for both
 * chains: the rows differ only in which registry the subtitle names, so the chain arrives as
 * `options` rather than as a forked copy of this file.
 *
 * Mirrors `SearchEnginePickerSheet`'s card-row layout: selected state is an accent border + tinted
 * background, no checkmark. Subtitles show the actual injected keys, since on Cardano that is the
 * part that decides whether a dApp finds the wallet at all.
 *
 * @module
 */

import {Pressable, ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {ChamferBackground} from '../Chamfer'
import {Modal} from '../Modal'
import {Typography} from '../Typography'

/** One selectable identity: its value, the name it reports, and the registry slots it installs. */
export type IdentityOption<T extends string> = {
  readonly value: T
  readonly walletName: string
  readonly keys: readonly string[]
}

type WalletIdentityPickerSheetProps<T extends string> = {
  visible: boolean
  selected: T
  options: readonly IdentityOption<T>[]
  /** The registry a row's keys live in, e.g. `window.cardano` — rendered as `<registry>.<key>`. */
  registry: string
  title: string
  description: string
  /** Distinguishes the two sheets in tests; rows append the option value. */
  testIDPrefix: string
  onSelect: (identity: T) => void
  onClose: () => void
}

export const WalletIdentityPickerSheet = <T extends string>({
  visible,
  selected,
  options,
  registry,
  title,
  description,
  testIDPrefix,
  onSelect,
  onClose,
}: WalletIdentityPickerSheetProps<T>) => {
  return (
    <Modal
      visible={visible}
      onClose={onClose}
      position="bottom"
      title={title}
      description={description}
      showDragIndicator
      contentContainerStyle={styles.modalContent}
      testID={`${testIDPrefix}-sheet`}
    >
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
        {options.map((option) => {
          const isSelected = option.value === selected
          return (
            <Pressable
              key={option.value}
              onPress={() => onSelect(option.value)}
              style={styles.option}
              accessibilityRole="radio"
              accessibilityState={{selected: isSelected}}
              testID={`${testIDPrefix}-option-${option.value}`}
            >
              <ChamferBackground
                size="auto"
                fillToken={isSelected ? 'accentMuted' : 'backgroundAlternative'}
                borderToken={isSelected ? 'primaryDefault' : 'borderDefaultWeak'}
                borderWidth={1}
              />
              <View style={styles.info}>
                <Typography variant="bodyMd_bold" style={styles.name}>
                  {option.walletName}
                </Typography>
                <Typography variant="bodyXs_regular" style={styles.sub}>
                  {option.keys.map((key) => `${registry}.${key}`).join(' · ')}
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
