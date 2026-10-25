/**
 * Tabs Showcase.
 *
 * Demonstrates tab navigation components.
 *
 * @module
 */

import {useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Tab, TabsWrapper} from '../../components/Tabs'
import {ShowcaseItem, ShowcaseSection} from '../components'

export const TabsShowcase = () => {
  const [activeTab, setActiveTab] = useState('all')
  const [scrollActiveTab, setScrollActiveTab] = useState('all')

  const basicTabs = [
    {key: 'all', label: 'All'},
    {key: 'sent', label: 'Sent'},
    {key: 'received', label: 'Received'},
  ]

  const manyTabs = [
    {key: 'all', label: 'All'},
    {key: 'tokens', label: 'Tokens'},
    {key: 'nfts', label: 'NFTs'},
    {key: 'staking', label: 'Staking'},
    {key: 'governance', label: 'Governance'},
    {key: 'swap', label: 'Swap'},
    {key: 'activity', label: 'Activity'},
  ]

  const tabsWithBadges = [
    {key: 'messages', label: 'Messages', badge: 5},
    {key: 'alerts', label: 'Alerts', badge: 128},
    {key: 'updates', label: 'Updates'},
  ]

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ShowcaseSection title="Tabs Wrapper" description="Basic tab container with indicator">
        <ShowcaseItem label="Basic">
          <View style={styles.tabsContainer}>
            <TabsWrapper tabs={basicTabs} activeTab={activeTab} onTabChange={setActiveTab} />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="With Badges">
          <View style={styles.tabsContainer}>
            <TabsWrapper tabs={tabsWithBadges} activeTab="messages" onTabChange={() => {}} />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Scrollable">
          <View style={styles.tabsContainer}>
            <TabsWrapper tabs={manyTabs} activeTab={scrollActiveTab} onTabChange={setScrollActiveTab} scrollable />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Individual Tab" description="Tab component states">
        <ShowcaseItem label="States">
          <Tab label="Active" isActive onPress={() => {}} />
          <Tab label="Inactive" isActive={false} onPress={() => {}} />
          <Tab label="Disabled" isActive={false} isDisabled onPress={() => {}} />
        </ShowcaseItem>
        <ShowcaseItem label="With Badge">
          <Tab label="Messages" isActive badge={5} onPress={() => {}} />
          <Tab label="Alerts" isActive={false} badge={128} onPress={() => {}} />
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
  tabsContainer: {
    width: '100%',
    backgroundColor: colors.backgroundAlternative,
    borderRadius: borderRadius.rounded12,
    padding: spacing.spacing8,
  },
}))
