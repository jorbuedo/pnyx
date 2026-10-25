/**
 * Blockchain-explorer selection screen — which site "view on explorer" links
 * open, across activity, receive, staking and governance.
 *
 * Every listed explorer covers every link type the app emits (tx, address,
 * stake, pool, token, DRep, block) on mainnet and both testnets, so the choice
 * never turns into a dead link.
 *
 * @module
 */

import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {SettingsPickerRow} from '../../src/components/SettingsPickerRow'
import {Typography} from '../../src/components/Typography'
import {EXPLORER_IDS, getExplorerDomain, getExplorerName} from '../../src/hooks/explorerConfig'
import {useExplorerPreference} from '../../src/hooks/useExplorerPreference'
import {useI18n} from '../../src/providers'

export default function ExplorerScreen() {
  const {t} = useI18n()
  const {explorerId, setExplorerId} = useExplorerPreference()

  return (
    <SafeAreaViewWrapper
      style={styles.safeArea}
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.scrollContent}
    >
      <Typography variant="bodySm_regular" style={styles.intro}>
        {t('settings.explorer.intro')}
      </Typography>
      <View style={styles.list}>
        {EXPLORER_IDS.map((id) => (
          <SettingsPickerRow
            key={id}
            label={getExplorerName(id)}
            sublabel={getExplorerDomain(id)}
            selected={id === explorerId}
            onPress={() => setExplorerId(id)}
            testID={`explorer-option-${id}`}
            checkboxVariant="radio"
          />
        ))}
      </View>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.spacing16,
    paddingBottom: spacing.spacing80,
    gap: spacing.spacing12,
  },
  intro: {
    color: colors.textAlternative,
    paddingHorizontal: spacing.spacing4,
  },
  list: {
    gap: spacing.spacing6,
  },
}))
