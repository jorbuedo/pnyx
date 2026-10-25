/**
 * UI Playground main screen.
 *
 * Renders every catalogued component, grouped by category.
 * Allows design team to view and tune components in isolation.
 *
 * @module
 */

import {router, useLocalSearchParams} from 'expo-router'
import {Pressable, ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {ChamferBackground} from '../../src/components/Chamfer'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../src/components/Typography'
import {CATEGORIES, type CategoryKey} from '../../src/playground/showcases'

export default function UIPlaygroundScreen() {
  // Kept in the route so a reload (and Metro's frequent ones during UI work) does
  // not throw you back to the first category.
  const {category} = useLocalSearchParams<{category?: string}>()
  const activeCategory: CategoryKey = CATEGORIES.find((c) => c.key === category)?.key ?? 'buttons'
  const setActiveCategory = (key: CategoryKey) => router.setParams({category: key})

  const ActiveShowcase = CATEGORIES.find((c) => c.key === activeCategory)?.Component

  return (
    <SafeAreaViewWrapper style={styles.container} edges={['bottom']}>
      {/* Category tabs */}
      <View style={styles.tabsContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabsContent}>
          {CATEGORIES.map((cat) => (
            <Pressable key={cat.key} onPress={() => setActiveCategory(cat.key)} style={styles.tab}>
              {activeCategory === cat.key && <ChamferBackground size="auto" fillToken="primaryDefault" />}
              <Typography
                variant="bodySm_medium"
                style={activeCategory === cat.key ? styles.tabTextActive : styles.tabText}
              >
                {cat.label}
              </Typography>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      {/* Showcase content */}
      <View style={styles.content}>{ActiveShowcase && <ActiveShowcase />}</View>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  tabsContainer: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderDefaultWeak,
  },
  tabsContent: {
    paddingHorizontal: theme.spacing.spacing8,
    gap: theme.spacing.spacing4,
  },
  tab: {
    paddingHorizontal: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing8,
  },

  tabText: {
    color: theme.colors.textAlternative,
  },
  tabTextActive: {
    color: theme.colors.primaryInverse,
  },
  content: {
    flex: 1,
  },
}))
