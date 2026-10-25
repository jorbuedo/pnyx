/**
 * Shared legal-document viewer — a modal screen that loads a markdown document
 * and renders it under a titled header with a close button. Privacy Policy and
 * Terms of Service are the same screen differing only in title + loader.
 *
 * @module
 */

import {router} from 'expo-router'
import {useEffect, useState} from 'react'
import {Pressable, ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {CircleLoader} from '../components/Loaders'
import {SafeAreaViewWrapper} from '../components/SafeAreaViewWrapper'
import {Typography} from '../components/Typography'
import {UniIcon} from '../components/UniIcon'
import {Markdown} from '../utils/markdown'

export type LegalDocumentScreenProps = {
  /** Localized header title. */
  readonly title: string
  /** Loads the markdown body (async — bundled asset read). */
  readonly load: () => Promise<string>
  readonly testID?: string
}

export function LegalDocumentScreen({title, load, testID}: LegalDocumentScreenProps) {
  const [content, setContent] = useState<string>('')
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let active = true
    setIsLoading(true)
    load()
      .then((text) => {
        if (active) setContent(text)
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })
    return () => {
      active = false
    }
  }, [load])

  return (
    <SafeAreaViewWrapper style={styles.container} noPadding edges={['top']} testID={testID}>
      <View style={styles.header}>
        <Typography variant="headingMd">{title}</Typography>
        <Pressable onPress={() => router.back()} style={styles.closeButton}>
          <UniIcon name="close" size="md" uniProps={(t) => ({color: t.colors.textDefault})} />
        </Pressable>
      </View>

      {isLoading ? (
        <View style={styles.loadingContainer}>
          <CircleLoader size="lg" />
        </View>
      ) : (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <Markdown>{content}</Markdown>
        </ScrollView>
      )}
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme, rt) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.backgroundDefault,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.spacing16,
    paddingVertical: theme.spacing.spacing16,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderDefaultWeak,
  },
  closeButton: {
    padding: theme.spacing.spacing8,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: theme.spacing.spacing16,
    paddingBottom: rt.insets.bottom + theme.spacing.spacing16,
  },
}))
