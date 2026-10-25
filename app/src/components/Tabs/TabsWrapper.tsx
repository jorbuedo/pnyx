/**
 * TabsWrapper component.
 *
 * Container for tab buttons with animated indicator.
 *
 * @module
 */

import {type ReactElement, useCallback, useState} from 'react'
import {type LayoutChangeEvent, ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Tab, type TabProps} from './Tab'
import {TabIndicator} from './TabIndicator'

type TabItem = Omit<TabProps, 'isActive' | 'onPress'> & {
  /** Unique tab identifier */
  key: string
}

export type TabsWrapperProps = {
  /** Array of tab items */
  tabs: TabItem[]
  /** Currently active tab key */
  activeTab: string
  /** Tab change handler */
  onTabChange: (key: string) => void
  /** Whether tabs should scroll horizontally */
  scrollable?: boolean | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
}

type TabMeasurement = {
  width: number
  offset: number
}

/**
 * TabsWrapper component.
 *
 * Container that manages a set of tabs with an animated indicator.
 *
 * @example
 * ```tsx
 * <TabsWrapper
 *   tabs={[
 *     {key: 'overview', label: 'Overview'},
 *     {key: 'transactions', label: 'Transactions', badge: 5},
 *     {key: 'nfts', label: 'NFTs'},
 *   ]}
 *   activeTab={activeTab}
 *   onTabChange={setActiveTab}
 * />
 * ```
 */
export const TabsWrapper = ({
  tabs,
  activeTab,
  onTabChange,
  scrollable = false,
  testID,
}: TabsWrapperProps): ReactElement => {
  const [measurements, setMeasurements] = useState<Record<string, TabMeasurement>>({})

  const handleTabLayout = useCallback(
    (key: string) => (event: LayoutChangeEvent) => {
      const {width, x} = event.nativeEvent.layout
      setMeasurements((prev) => ({
        ...prev,
        [key]: {width, offset: x},
      }))
    },
    [],
  )

  const activeMeasurement = measurements[activeTab]

  const content = (
    <View style={styles.tabsContainer} accessibilityRole="tablist">
      {tabs.map((tab) => (
        <View key={tab.key} onLayout={handleTabLayout(tab.key)}>
          <Tab
            label={tab.label}
            isActive={activeTab === tab.key}
            onPress={() => onTabChange(tab.key)}
            badge={tab.badge}
            isDisabled={tab.isDisabled}
            testID={tab.testID}
          />
        </View>
      ))}
      {activeMeasurement ? <TabIndicator width={activeMeasurement.width} offset={activeMeasurement.offset} /> : null}
    </View>
  )

  return (
    <View style={styles.container} testID={testID}>
      {scrollable ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {content}
        </ScrollView>
      ) : (
        content
      )}
    </View>
  )
}

const styles = StyleSheet.create(({colors}) => ({
  container: {
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDefaultWeak,
  },
  tabsContainer: {
    flexDirection: 'row' as const,
    position: 'relative' as const,
  },
}))
