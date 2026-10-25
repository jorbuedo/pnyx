/**
 * Full-screen search overlay.
 *
 * Slides up from the URL pill tap. Search input + Cancel button + the
 * standard "Cardano dApps supported" hint, then a list of recently-
 * visited URLs sourced from the browser history storage. Tapping a
 * recent URL submits it to the active tab.
 *
 * The native keyboard is used (no custom keyboard). The input is auto-
 * focused on mount and seeded with the active tab's current URL so the
 * user can edit rather than retype.
 *
 * @module
 */

import {useEffect, useRef, useState} from 'react'
import {Modal, Platform, Pressable, ScrollView, type TextInput, type TextStyle, View} from 'react-native'
import {StyleSheet, useUnistyles} from 'react-native-unistyles'
import {logger} from '../../logger'
import {useI18n} from '../../providers'
import type {BrowserHistoryEntry, BrowserHistoryStorage} from '../../services/browser-history-storage'
import type {BrowserSearchEngine} from '../../services/browser-prefs-storage'
import {ChamferBackground} from '../Chamfer'
import {TextInputBase} from '../TextInputBase'
import {Typography} from '../Typography'
import {UniIcon} from '../UniIcon'

type SearchOverlayProps = {
  visible: boolean
  initialUrl: string
  searchEngine: BrowserSearchEngine
  /** Storage handle used to read recently-visited URLs while the overlay is open. */
  historyStorage: BrowserHistoryStorage
  onSubmit: (rawInput: string) => void
  onClose: () => void
}

const RECENTS_LIMIT = 8

const friendlyHost = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch (e: unknown) {
    logger.debug('URL could not be parsed for display; showing it raw', {
      origin: 'SearchOverlay',
      error: String(e),
    })
    return url
  }
}

export const SearchOverlay = ({
  visible,
  initialUrl,
  searchEngine,
  historyStorage,
  onSubmit,
  onClose,
}: SearchOverlayProps) => {
  const {t} = useI18n()
  const {theme} = useUnistyles()
  const [value, setValue] = useState(initialUrl)
  const [recents, setRecents] = useState<readonly BrowserHistoryEntry[]>([])
  const inputRef = useRef<TextInput>(null)

  useEffect(() => {
    if (visible) {
      setValue(initialUrl)
      // Defer focus until after the modal mount transition finishes — focusing
      // synchronously on iOS sometimes loses the cursor to the underlying screen.
      const handle = setTimeout(() => inputRef.current?.focus(), 80)
      // Refresh recents on each open so a navigation made between opens is
      // visible without remounting the overlay.
      historyStorage
        .getHistory()
        .then((entries) => {
          // Dedupe by URL keeping the most recent entry; cap to RECENTS_LIMIT.
          const seen = new Set<string>()
          const out: BrowserHistoryEntry[] = []
          for (const entry of entries) {
            if (seen.has(entry.url)) continue
            seen.add(entry.url)
            out.push(entry)
            if (out.length >= RECENTS_LIMIT) break
          }
          setRecents(out)
        })
        .catch((e) => {
          logger.warn('Browser recents read failed; showing none', {origin: 'SearchOverlay', error: String(e)})
          setRecents([])
        })
      return () => clearTimeout(handle)
    }
    return undefined
  }, [visible, initialUrl, historyStorage])

  const handleSubmit = () => {
    const trimmed = value.trim()
    if (!trimmed) return
    onSubmit(trimmed)
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="overFullScreen" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.headerRow}>
          <View style={styles.inputContainer}>
            <ChamferBackground size="auto" fillToken="backgroundAlternative" />
            <UniIcon name="search" size="xs" uniProps={(theme) => ({color: theme.colors.textAlternative})} />
            <TextInputBase
              ref={inputRef}
              value={value}
              onChangeText={setValue}
              onSubmitEditing={handleSubmit}
              placeholder={t('browser.searchPlaceholder', {engine: t(`browser.searchEngines.${searchEngine}`)})}
              placeholderTextColor={theme.colors.textAlternative}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              selectTextOnFocus
              style={[styles.input, Platform.OS === 'web' ? ({boxSizing: 'border-box'} as TextStyle) : null]}
              {...(Platform.OS === 'android' ? {textAlignVertical: 'center' as const, includeFontPadding: false} : {})}
            />
          </View>
          <Pressable onPress={onClose} accessibilityRole="button" hitSlop={6} style={styles.cancelButton}>
            <Typography variant="bodyMd_medium" style={styles.cancelLabel}>
              {t('browser.cancel')}
            </Typography>
          </Pressable>
        </View>

        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll}>
          <View style={styles.hintBlock}>
            <Typography variant="bodyMd_regular" style={styles.hint}>
              {t('browser.startHint')}
            </Typography>
          </View>

          {recents.length > 0 && (
            <View style={styles.recentsSection}>
              <Typography variant="bodyXs_medium" style={styles.recentsHeader}>
                {t('browser.recentsHeader').toUpperCase()}
              </Typography>
              {recents.map((entry) => (
                <Pressable
                  key={entry.url}
                  onPress={() => onSubmit(entry.url)}
                  style={styles.recentRow}
                  accessibilityRole="button"
                  accessibilityLabel={entry.title ?? entry.url}
                >
                  <UniIcon name="globe" size="xs" uniProps={(theme) => ({color: theme.colors.textAlternative})} />
                  <View style={styles.recentTextBlock}>
                    <Typography variant="bodyMd_medium" numberOfLines={1} style={styles.recentTitle}>
                      {entry.title || friendlyHost(entry.url)}
                    </Typography>
                    <Typography variant="bodySm_regular" numberOfLines={1} style={styles.recentUrl}>
                      {entry.url}
                    </Typography>
                  </View>
                </Pressable>
              ))}
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create(({colors, spacing, textVariants}, rt) => ({
  container: {
    flex: 1,
    backgroundColor: colors.backgroundDefault,
    paddingTop: rt.insets.top,
    paddingBottom: rt.insets.bottom,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.spacing16,
    paddingVertical: spacing.spacing12,
    gap: spacing.spacing12,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDefaultWeak,
  },
  inputContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.spacing12,
    paddingVertical: spacing.spacing8,
    gap: spacing.spacing8,
  },
  input: {
    flex: 1,
    minWidth: 0,
    margin: 0,
    padding: 0,
    color: colors.textDefault,
    fontSize: textVariants.bodyMd_regular.fontSize,
    fontFamily: textVariants.bodyMd_regular.fontFamily,
  },
  cancelButton: {
    paddingVertical: spacing.spacing4,
  },
  cancelLabel: {
    color: colors.primaryDefault,
  },
  scroll: {
    paddingBottom: spacing.spacing24,
  },
  hintBlock: {
    paddingHorizontal: spacing.spacing24,
    paddingVertical: spacing.spacing24,
  },
  hint: {
    color: colors.textAlternative,
    textAlign: 'center' as const,
  },
  recentsSection: {
    paddingHorizontal: spacing.spacing16,
  },
  recentsHeader: {
    color: colors.textAlternative,
    paddingHorizontal: spacing.spacing4,
    paddingBottom: spacing.spacing8,
    letterSpacing: 0.4,
  },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center' as const,
    paddingVertical: spacing.spacing12,
    paddingHorizontal: spacing.spacing4,
    gap: spacing.spacing12,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDefaultWeak,
  },
  recentTextBlock: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  recentTitle: {
    color: colors.textDefault,
  },
  recentUrl: {
    color: colors.textAlternative,
  },
}))
