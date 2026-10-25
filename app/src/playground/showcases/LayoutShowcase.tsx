/**
 * Layout Showcase.
 *
 * Structural wrappers and settings-surface rows. These mostly shape their
 * children rather than draw anything themselves, so each is shown with filler
 * content and a visible bound.
 *
 * @module
 */

import {useRef, useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {AppShell} from '../../components/AppShell'
import {BlurRevealOverlay} from '../../components/BlurRevealOverlay'
import {BlobBackground} from '../../components/patterns/BlobBackground'
import {SectionHeader} from '../../components/SectionHeader'
import {SettingsGroup} from '../../components/SettingsGroup'
import {SettingsPickerRow} from '../../components/SettingsPickerRow'
import {SettingsRow} from '../../components/SettingsRow'
import {StickyFooter} from '../../components/StickyFooter'
import {SwipeToDeleteRow} from '../../components/SwipeToDeleteRow'
import {Typography} from '../../components/Typography'
import {ShowcaseItem, ShowcaseSection} from '../components'

const Filler = ({label}: {label: string}) => (
  <View style={styles.filler}>
    <Typography variant="bodySm_regular" style={styles.fillerText}>
      {label}
    </Typography>
  </View>
)

export const LayoutShowcase = () => {
  const [picked, setPicked] = useState('a')
  const blurTarget = useRef<View | null>(null)

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ShowcaseSection title="Section header">
        <ShowcaseItem label="SectionHeader">
          <View style={styles.full}>
            <SectionHeader title="Your wallets" />
            <SectionHeader title="Assets" trailingText="12" />
            <SectionHeader title="Activity" link={{label: 'See all', onPress: () => {}}} />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Settings surfaces">
        <ShowcaseItem label="SettingsGroup — card">
          <View style={styles.full}>
            <SettingsGroup label="General" variant="card">
              <SettingsRow label="Language" leftIcon="language" onPress={() => {}}>
                <Typography variant="bodySm_regular">English</Typography>
              </SettingsRow>
              <SettingsRow label="Currency" leftIcon="coins" onPress={() => {}}>
                <Typography variant="bodySm_regular">USD</Typography>
              </SettingsRow>
            </SettingsGroup>
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="SettingsGroup — stacked">
          <View style={styles.full}>
            <SettingsGroup label="Security" variant="stacked">
              <SettingsRow label="App lock" onPress={() => {}} />
            </SettingsGroup>
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="SettingsPickerRow — check">
          <View style={styles.full}>
            <SettingsPickerRow label="English" selected={picked === 'a'} onPress={() => setPicked('a')} />
            <SettingsPickerRow
              label="Japanese"
              sublabel="日本語"
              selected={picked === 'b'}
              onPress={() => setPicked('b')}
            />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="SettingsPickerRow — radio">
          <View style={styles.full}>
            <SettingsPickerRow
              label="Automatic"
              checkboxVariant="radio"
              selected={picked === 'c'}
              onPress={() => setPicked('c')}
            />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Cards & rows">
        <ShowcaseItem label="SwipeToDeleteRow">
          <View style={styles.full}>
            <SwipeToDeleteRow onDelete={() => {}}>
              <Filler label="Swipe me left" />
            </SwipeToDeleteRow>
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Structural wrappers" description="Shape their children; shown with filler.">
        <ShowcaseItem label="AppShell">
          <View style={styles.bounded}>
            <AppShell>
              <Filler label="AppShell content" />
            </AppShell>
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="StickyFooter">
          <View style={styles.bounded}>
            <StickyFooter>
              <Filler label="Footer content" />
            </StickyFooter>
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="BlobBackground">
          <View style={styles.bounded}>
            <BlobBackground>
              <Filler label="On the blob" />
            </BlobBackground>
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="BlurRevealOverlay">
          <View ref={blurTarget} style={styles.bounded}>
            <Filler label="Behind the overlay" />
            <BlurRevealOverlay blurTarget={blurTarget} />
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
  bounded: {
    width: '100%',
    height: 120,
    borderRadius: borderRadius.rounded12,
    borderWidth: 1,
    borderColor: colors.borderDefaultWeak,
    overflow: 'hidden',
  },
  filler: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.backgroundAlternative,
    borderRadius: borderRadius.rounded8,
    paddingHorizontal: spacing.spacing12,
  },
  fillerText: {
    color: colors.textAlternative,
  },
}))
