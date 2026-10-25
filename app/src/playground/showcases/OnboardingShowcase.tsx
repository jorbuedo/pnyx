/**
 * Onboarding Showcase.
 *
 * The wallet-creation tiles in the surfaces they were drawn for. The glyphs
 * themselves live in the Icons category, alongside the chain marks.
 *
 * @module
 */

import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {OnboardingTile} from '../../components/OnboardingTile'
import {PreparingAnimation} from '../../components/onboarding/PreparingAnimation'
import {UniIcon} from '../../components/UniIcon'
import {ShowcaseItem, ShowcaseSection} from '../components'

export const OnboardingShowcase = () => {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ShowcaseSection title="Tiles" description="The glyph in the surface it was drawn for.">
        <ShowcaseItem label="OnboardingTile">
          <View style={styles.full}>
            <OnboardingTile
              icon={<UniIcon name="tileCreateWallet" size="sm" uniProps={(t) => ({color: t.colors.textDefault})} />}
              title="Create a new wallet"
              subtitle="Generate a recovery phrase on this device"
              onPress={() => {}}
            />
            <OnboardingTile
              icon={<UniIcon name="tileQuickstart" size="sm" uniProps={(t) => ({color: t.colors.textDefault})} />}
              title="Quickstart"
              subtitle="Fastest route in"
              recommended
              onPress={() => {}}
            />
            <OnboardingTile
              icon={<UniIcon name="tileHardwareWallet" size="sm" uniProps={(t) => ({color: t.colors.textDefault})} />}
              title="Hardware wallet"
              badge="Beta"
              onPress={() => {}}
            />
            <OnboardingTile
              icon={<UniIcon name="tileMultisigWallet" size="sm" uniProps={(t) => ({color: t.colors.textDefault})} />}
              title="Multi-signature"
              subtitle="Not available yet"
              onPress={() => {}}
              isDisabled
            />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Progress">
        <ShowcaseItem label="PreparingAnimation — wallet">
          <View style={styles.bounded}>
            <PreparingAnimation active variant="wallet" />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="PreparingAnimation — identity">
          <View style={styles.bounded}>
            <PreparingAnimation active variant="identity" />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>
    </ScrollView>
  )
}

const styles = StyleSheet.create(({colors, spacing, borderRadius}) => ({
  container: {
    flex: 1,
  },
  content: {
    paddingVertical: spacing.spacing16,
    gap: spacing.spacing24,
  },
  full: {
    width: '100%',
    gap: spacing.spacing8,
  },
  grid: {
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: spacing.spacing8,
  },
  bounded: {
    width: '100%',
    height: 160,
    borderRadius: borderRadius.rounded12,
    borderWidth: 1,
    borderColor: colors.borderDefaultWeak,
    overflow: 'hidden',
  },
}))
