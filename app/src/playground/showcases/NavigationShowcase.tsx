/**
 * Navigation Showcase.
 *
 * What the app actually navigates with. Bottom tabs and stack headers come
 * from expo-router's own navigators — `Tabs` in `app/(tabs)/_layout.tsx` and
 * `Stack` via `getSharedStackScreenOptions` — so the only bespoke pieces are
 * the header rendered into them and the inline switch.
 *
 * @module
 */

import {useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {AppTopBar} from '../../components/AppTopBar'
import {HeaderBackButton} from '../../components/HeaderBackButton'
import {SegmentedControl} from '../../components/SegmentedControl'
import {ShowcaseItem, ShowcaseSection} from '../components'

export const NavigationShowcase = () => {
  const [segment, setSegment] = useState('buy')

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ShowcaseSection
        title="App Top Bar"
        description="Rendered as the Tabs navigator header, so it appears on every tab screen. Reads the live identity from the session provider — signed out here, hence the placeholder."
      >
        <ShowcaseItem label="AppTopBar">
          <View style={styles.bar}>
            <AppTopBar />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection
        title="Header Back Button"
        description="Passed as `headerLeft` by the shared stack options, so every pushed screen gets it."
      >
        <ShowcaseItem label="HeaderBackButton">
          <HeaderBackButton onBack={() => {}} />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Segmented Control" description="Inline mutually-exclusive switch.">
        <ShowcaseItem label="SegmentedControl — three options">
          <View style={styles.bar}>
            <SegmentedControl
              options={[
                {label: 'Buy', value: 'buy'},
                {label: 'Sell', value: 'sell'},
                {label: 'Swap', value: 'swap'},
              ]}
              value={segment}
              onChange={setSegment}
            />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="SegmentedControl — two options">
          <View style={styles.bar}>
            <SegmentedControl
              options={[
                {label: 'Pools', value: 'buy'},
                {label: 'DReps', value: 'sell'},
              ]}
              value={segment}
              onChange={setSegment}
            />
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
  bar: {
    width: '100%',
    backgroundColor: colors.backgroundAlternative,
    borderRadius: borderRadius.rounded12,
    overflow: 'hidden',
  },
}))
