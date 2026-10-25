/**
 * Icon Gallery Showcase.
 *
 * Displays all available UniIcon icons organized by category.
 *
 * @module
 */

import {useState} from 'react'
import {Pressable, ScrollView, View} from 'react-native'
import {StyleSheet, useUnistyles} from 'react-native-unistyles'
import {Bitcoin, Cardano, Ethereum, Midnight, Solana} from '../../components/icons/networks'
import {Typography} from '../../components/Typography'
import {UniIcon, type UniIconName} from '../../components/UniIcon'
import {iconSources} from '../../components/UniIcon/UniIcon.map'
import {ShowcaseItem, ShowcaseSection} from '../components'

const NETWORK_MARKS = [
  {name: 'Cardano', Mark: Cardano},
  {name: 'Midnight', Mark: Midnight},
  {name: 'Bitcoin', Mark: Bitcoin},
  {name: 'Ethereum', Mark: Ethereum},
  {name: 'Solana', Mark: Solana},
] as const

const ICONS = Object.keys(iconSources) as UniIconName[]

/** Google's four-colour mark; a tint would flatten it to mono. */
const UNTINTED = 'tileSocialGoogle'

const IconItem = ({
  name,
  onPress,
  isSelected,
  color,
}: {
  name: UniIconName
  onPress: () => void
  isSelected: boolean
  color?: string
}) => (
  <Pressable style={[itemStyles.container, isSelected && itemStyles.containerSelected]} onPress={onPress}>
    <UniIcon name={name} size="lg" {...(color ? {color} : {})} />
  </Pressable>
)

const itemStyles = StyleSheet.create(({colors, borderRadius}) => ({
  container: {
    width: 56,
    height: 56,
    borderRadius: borderRadius.rounded12,
    backgroundColor: colors.backgroundAlternative,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  containerSelected: {
    borderColor: colors.primaryDefault,
    backgroundColor: `${colors.primaryDefault}15`,
  },
}))

export const IconGalleryShowcase = () => {
  const {theme} = useUnistyles()
  const [selectedIcon, setSelectedIcon] = useState<UniIconName | null>(null)

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ShowcaseSection title="Icon Gallery" description={`${ICONS.length} icons available`}>
        {selectedIcon && (
          <ShowcaseItem label="Selected">
            <View style={styles.selectedIconContainer}>
              <View style={styles.selectedIconPreview}>
                <UniIcon
                  name={selectedIcon}
                  size="xl"
                  {...(selectedIcon === UNTINTED ? {} : {color: theme.colors.iconDefault})}
                />
              </View>
              <View style={styles.selectedIconInfo}>
                <Typography variant="bodyLg_semibold">{selectedIcon}</Typography>
                <Typography variant="bodyXs_medium" style={styles.selectedIconUsage}>
                  {`<UniIcon name="${selectedIcon}" />`}
                </Typography>
              </View>
            </View>
          </ShowcaseItem>
        )}

        <ShowcaseItem label={`All icons (${ICONS.length})`}>
          <View style={styles.iconGrid}>
            {ICONS.map((name) => (
              <IconItem
                key={name}
                name={name}
                onPress={() => setSelectedIcon(name)}
                isSelected={selectedIcon === name}
                {...(name === UNTINTED ? {} : {color: theme.colors.iconDefault})}
              />
            ))}
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection
        title="Chain marks"
        description="Standalone react-native-svg components, not registry entries — each carries its chain's brand colours, so they do not tint."
      >
        <ShowcaseItem label="icons/networks" inline>
          {NETWORK_MARKS.map(({name, Mark}) => (
            <View key={name} style={styles.markCell}>
              <Mark size={40} />
              <Typography variant="bodyXs_regular" style={styles.markLabel}>
                {name}
              </Typography>
            </View>
          ))}
        </ShowcaseItem>
      </ShowcaseSection>
    </ScrollView>
  )
}

const styles = StyleSheet.create(({colors, spacing, borderRadius}) => ({
  markCell: {
    width: 64,
    alignItems: 'center',
    gap: spacing.spacing4,
  },
  markLabel: {
    color: colors.textAlternative,
  },
  container: {
    flex: 1,
  },
  content: {
    paddingVertical: spacing.spacing16,
    gap: spacing.spacing24,
  },
  categoryTabs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.spacing8,
  },
  categoryTab: {
    paddingHorizontal: spacing.spacing12,
    paddingVertical: spacing.spacing8,
    borderRadius: borderRadius.rounded12,
    backgroundColor: colors.backgroundAlternative,
  },
  categoryTabActive: {
    backgroundColor: colors.primaryDefault,
  },
  categoryTabText: {
    color: colors.textDefault,
  },
  categoryTabTextActive: {
    color: colors.primaryForeground,
  },
  selectedIconContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.spacing16,
    backgroundColor: colors.backgroundAlternative,
    padding: spacing.spacing16,
    borderRadius: borderRadius.rounded12,
    width: '100%',
  },
  selectedIconPreview: {
    width: 64,
    height: 64,
    borderRadius: borderRadius.rounded12,
    backgroundColor: colors.backgroundDefault,
    justifyContent: 'center',
    alignItems: 'center',
  },
  selectedIconInfo: {
    flex: 1,
    gap: spacing.spacing4,
  },
  selectedIconUsage: {
    fontFamily: 'monospace',
    color: colors.textAlternative,
    backgroundColor: colors.backgroundDefault,
    paddingHorizontal: spacing.spacing8,
    paddingVertical: spacing.spacing4,
    borderRadius: borderRadius.rounded8,
    overflow: 'hidden',
  },
  iconGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.spacing8,
    width: '100%',
  },
}))
