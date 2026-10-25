/**
 * System logs viewer body — rendered by the Settings → Dev → Logs route.
 * Reads from `logger.trail` on a 2s poll.
 *
 * Capabilities:
 * - Level filter chips (debug/info/warn/error)
 * - Text search (message + origin)
 * - Expandable rows showing extra metadata (with bigInt-safe JSON)
 * - Per-entry copy + "Copy until/from here" range copy
 * - Copy filtered set / Clear trail
 *
 * `onClose` is provided by the overlay — when present, the header includes
 * a title + close affordance. The settings route omits it and relies on the
 * Expo Router header.
 *
 * @module
 */

import {useCallback, useEffect, useMemo, useState} from 'react'
import {Alert, FlatList, Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import type {LogEntry, LogLevel} from '../logger'
import {logger} from '../logger'
import {copyToClipboard} from '../platform/clipboard'
import {useI18n} from '../providers'
import {confirmDialog, reloadApp, wipeAllStorage} from './dev-actions'
import {TextInputBase} from './TextInputBase'
import {Typography} from './Typography'

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '#64748B',
  info: '#2563EB',
  warn: '#D97706',
  error: '#DC2626',
}

const POLL_INTERVAL_MS = 2000

const formatTime = (timestamp: number): string => {
  const date = new Date(timestamp)
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  const ms = String(date.getMilliseconds()).padStart(3, '0')
  return `${h}:${m}:${s}.${ms}`
}

/** Extract metadata fields excluding origin/type (already shown in badges). */
const getExtraMetadata = (metadata: LogEntry['metadata']): Record<string, unknown> | null => {
  const {origin, type, ...rest} = metadata
  return Object.keys(rest).length > 0 ? rest : null
}

const bigIntReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)

const formatMetadata = (extra: Record<string, unknown>): string => {
  try {
    return JSON.stringify(extra, bigIntReplacer, 2)
  } catch (e: unknown) {
    // `console`, not the logger: this formats entries FOR the log view, so logging here would
    // write into the stream it is rendering.
    console.debug(`[DevLogsView] metadata could not be serialised: ${String(e)}`)
    return String(extra)
  }
}

const formatMetadataPreview = (extra: Record<string, unknown>, maxLength = 80): string => {
  try {
    const json = JSON.stringify(extra, bigIntReplacer)
    return json.length > maxLength ? `${json.slice(0, maxLength)}...` : json
  } catch (e: unknown) {
    console.debug(`[DevLogsView] metadata preview could not be serialised: ${String(e)}`)
    return String(extra).slice(0, maxLength)
  }
}

const formatEntryAsText = (entry: LogEntry): string => {
  const time = formatTime(entry.timestamp)
  const origin = entry.metadata.origin ? `[${entry.metadata.origin}] ` : ''
  const extra = getExtraMetadata(entry.metadata)
  const metaStr = extra ? ` ${JSON.stringify(extra, bigIntReplacer)}` : ''
  return `${time} ${entry.level.toUpperCase().padEnd(5)} ${origin}${entry.message}${metaStr}`
}

const formatLogsAsText = (entries: readonly LogEntry[]): string => entries.map(formatEntryAsText).join('\n')

function LevelChip({level, active, onToggle}: {level: LogLevel; active: boolean; onToggle: (level: LogLevel) => void}) {
  const color = LEVEL_COLORS[level]
  return (
    <Pressable
      onPress={() => onToggle(level)}
      style={[styles.chip, active ? {backgroundColor: color} : styles.chipInactive]}
      testID={`dev-logs-level-${level}`}
    >
      <Typography variant="bodyXs_medium" style={active ? styles.chipTextActive : styles.chipTextInactive}>
        {level.toUpperCase()}
      </Typography>
    </Pressable>
  )
}

function LogRow({
  entry,
  onCopyEntry,
  onCopyUntilHere,
  onCopyFromHere,
}: {
  entry: LogEntry
  onCopyEntry: (entry: LogEntry) => void
  onCopyUntilHere: (entry: LogEntry) => void
  onCopyFromHere: (entry: LogEntry) => void
}) {
  const {t} = useI18n()
  const [expanded, setExpanded] = useState(false)
  const color = LEVEL_COLORS[entry.level]
  const origin = entry.metadata.origin
  const extra = useMemo(() => getExtraMetadata(entry.metadata), [entry.metadata])

  return (
    <Pressable style={styles.logRow} onPress={() => setExpanded((prev) => !prev)}>
      <View style={styles.logHeader}>
        <Typography variant="bodyXs_regular" style={styles.timestamp}>
          {formatTime(entry.timestamp)}
        </Typography>
        <View style={[styles.levelBadge, {backgroundColor: color}]}>
          <Typography variant="bodyXs_medium" style={styles.levelBadgeText}>
            {entry.level.toUpperCase()}
          </Typography>
        </View>
        {origin != null && (
          <View style={styles.originBadge}>
            <Typography variant="bodyXs_regular" style={styles.originText}>
              {origin}
            </Typography>
          </View>
        )}
      </View>
      <Typography variant="bodyXs_regular" style={styles.message} numberOfLines={expanded ? undefined : 2}>
        {entry.message}
      </Typography>
      {extra != null && !expanded && (
        <Typography variant="bodyXs_regular" style={styles.metadataPreview} numberOfLines={1}>
          {formatMetadataPreview(extra)}
        </Typography>
      )}
      {extra != null && expanded && (
        <View style={styles.metadataBlock}>
          <Typography variant="bodyXs_regular" style={styles.metadataFull}>
            {formatMetadata(extra)}
          </Typography>
        </View>
      )}
      {expanded && (
        <View style={styles.entryActions}>
          <Pressable onPress={() => onCopyEntry(entry)} style={styles.entryActionButton} hitSlop={6}>
            <Typography variant="bodyXs_medium" style={styles.entryActionText}>
              {t('settings.developer.logsCopyEntry')}
            </Typography>
          </Pressable>
          <Pressable onPress={() => onCopyUntilHere(entry)} style={styles.entryActionButton} hitSlop={6}>
            <Typography variant="bodyXs_medium" style={styles.entryActionText}>
              {t('settings.developer.logsCopyUntilHere')}
            </Typography>
          </Pressable>
          <Pressable onPress={() => onCopyFromHere(entry)} style={styles.entryActionButton} hitSlop={6}>
            <Typography variant="bodyXs_medium" style={styles.entryActionText}>
              {t('settings.developer.logsCopyFromHere')}
            </Typography>
          </Pressable>
        </View>
      )}
    </Pressable>
  )
}

type Props = {
  /** When provided, renders a "System Logs" title and a close button in the header. */
  onClose?: () => void
  /**
   * When false, the 2s polling interval is paused. The overlay passes its `visible`
   * flag here because `Modal` keeps its children mounted when hidden — without this,
   * the timer would run for the entire app lifetime once the FAB is shown. Defaults
   * to true for the Settings route, which unmounts naturally on navigation.
   */
  active?: boolean
}

export function DevLogsView({onClose, active = true}: Props) {
  const {t} = useI18n()
  const [entries, setEntries] = useState<readonly LogEntry[]>([])
  const [activeLevels, setActiveLevels] = useState<Set<LogLevel>>(new Set(LOG_LEVELS))
  const [searchText, setSearchText] = useState('')

  useEffect(() => {
    if (!active) return
    let mounted = true
    let lastId: string | undefined

    const load = () => {
      if (!mounted) return
      const trail = logger.trail
      const latestId = trail.length > 0 ? trail[trail.length - 1]?.id : undefined
      if (latestId === lastId) return
      lastId = latestId
      setEntries([...trail])
    }

    load()
    const interval = setInterval(load, POLL_INTERVAL_MS)
    return () => {
      mounted = false
      clearInterval(interval)
    }
  }, [active])

  const toggleLevel = useCallback((level: LogLevel) => {
    setActiveLevels((prev) => {
      const next = new Set(prev)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return next
    })
  }, [])

  const filteredEntries = useMemo(() => {
    const search = searchText.toLowerCase()
    return entries.filter((entry) => {
      if (!activeLevels.has(entry.level)) return false
      if (search.length > 0) {
        const origin = (entry.metadata.origin ?? '').toLowerCase()
        const message = entry.message.toLowerCase()
        if (!message.includes(search) && !origin.includes(search)) return false
      }
      return true
    })
  }, [entries, activeLevels, searchText])

  const reversedEntries = useMemo(() => [...filteredEntries].reverse(), [filteredEntries])

  const handleCopy = useCallback(async () => {
    const text = formatLogsAsText(filteredEntries)
    await copyToClipboard(text)
    Alert.alert(
      t('settings.developer.logsCopiedTitle'),
      t('settings.developer.logsBulkCopied', {count: filteredEntries.length}),
    )
  }, [filteredEntries, t])

  const handleClear = useCallback(() => {
    logger.clearTrail()
    setEntries([])
  }, [])

  const handleCopyEntry = useCallback(
    async (entry: LogEntry) => {
      const text = formatEntryAsText(entry)
      await copyToClipboard(text)
      Alert.alert(t('settings.developer.logsCopiedTitle'), t('settings.developer.logsEntryCopied'))
    },
    [t],
  )

  const handleCopyUntilHere = useCallback(
    async (entry: LogEntry) => {
      const idx = filteredEntries.findIndex((e) => e.id === entry.id)
      if (idx === -1) return
      const slice = filteredEntries.slice(0, idx + 1)
      const text = formatLogsAsText(slice)
      await copyToClipboard(text)
      Alert.alert(
        t('settings.developer.logsCopiedTitle'),
        t('settings.developer.logsBulkCopied', {count: slice.length}),
      )
    },
    [filteredEntries, t],
  )

  const handleCopyFromHere = useCallback(
    async (entry: LogEntry) => {
      const idx = filteredEntries.findIndex((e) => e.id === entry.id)
      if (idx === -1) return
      const slice = filteredEntries.slice(idx)
      const text = formatLogsAsText(slice)
      await copyToClipboard(text)
      Alert.alert(
        t('settings.developer.logsCopiedTitle'),
        t('settings.developer.logsBulkCopied', {count: slice.length}),
      )
    },
    [filteredEntries, t],
  )

  // Destructive dev actions surfaced in the LOG overlay (replaces the
  // standalone WIPE / UNAUTH / UNAUTH FULL FABs). Each one confirms via
  // Alert.alert and then reloads via the platform-appropriate `reloadApp`.
  const runWithConfirm = useCallback(
    async (title: string, message: string, destructiveLabel: string, action: () => Promise<void>) => {
      const ok = await confirmDialog({title, message, confirmLabel: destructiveLabel})
      if (!ok) return
      try {
        await action()
      } catch (e) {
        logger.error(`${title} threw: ${e instanceof Error ? e.message : String(e)}`, {origin: 'DevActions'})
      }
      reloadApp()
    },
    [],
  )

  const handleWipe = useCallback(
    () =>
      runWithConfirm(
        t('settings.developer.devActionWipeTitle'),
        t('settings.developer.devActionWipeMessage'),
        t('settings.developer.devActionWipeConfirm'),
        wipeAllStorage,
      ),
    [runWithConfirm, t],
  )

  const renderItem = useCallback(
    ({item}: {item: LogEntry}) => (
      <LogRow
        entry={item}
        onCopyEntry={handleCopyEntry}
        onCopyUntilHere={handleCopyUntilHere}
        onCopyFromHere={handleCopyFromHere}
      />
    ),
    [handleCopyEntry, handleCopyUntilHere, handleCopyFromHere],
  )
  const keyExtractor = useCallback((item: LogEntry) => item.id, [])

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          {onClose != null ? (
            <Typography variant="headingMd" style={styles.title}>
              {t('settings.developer.logsTitle')}
            </Typography>
          ) : null}
          <View style={styles.headerActions}>
            <Typography variant="bodyXs_regular" style={styles.countBadge}>
              {filteredEntries.length} / {entries.length}
            </Typography>
            {onClose != null && (
              <Pressable onPress={onClose} style={styles.closeButton} hitSlop={12} testID="dev-logs-close">
                <Typography variant="bodyMd_medium" style={styles.closeButtonText}>
                  ✕
                </Typography>
              </Pressable>
            )}
          </View>
        </View>

        <View style={styles.filterBar}>
          <View style={styles.chips}>
            {LOG_LEVELS.map((level) => (
              <LevelChip key={level} level={level} active={activeLevels.has(level)} onToggle={toggleLevel} />
            ))}
          </View>
          <View style={styles.actionGroup}>
            <Pressable onPress={handleClear} style={styles.clearButton} testID="dev-logs-clear">
              <Typography variant="bodyXs_medium" style={styles.clearButtonText}>
                {t('settings.developer.logsClear')}
              </Typography>
            </Pressable>
            <Pressable onPress={handleCopy} style={styles.copyButton} testID="dev-logs-copy">
              <Typography variant="bodyXs_medium" style={styles.copyButtonText}>
                {t('settings.developer.logsCopy')}
              </Typography>
            </Pressable>
          </View>
        </View>

        <TextInputBase
          allowBrowserFocusRing
          style={styles.searchInput}
          placeholder={t('settings.developer.logsSearchPlaceholder')}
          placeholderTextColor="#94A3B8"
          value={searchText}
          onChangeText={setSearchText}
          autoCapitalize="none"
          autoCorrect={false}
          testID="dev-logs-search"
        />

        {/* Destructive dev actions — moved here from standalone FABs so the
            LOG button is the single dev surface on every screen. */}
        <View style={styles.devActionsRow}>
          <Pressable
            onPress={handleWipe}
            style={[styles.devActionButton, styles.devActionWipe]}
            testID="dev-action-wipe"
          >
            <Typography variant="bodyXs_medium" style={styles.devActionText}>
              {t('settings.developer.devActionWipeShort')}
            </Typography>
          </Pressable>
        </View>
      </View>

      {reversedEntries.length === 0 ? (
        <View style={styles.empty}>
          <Typography variant="bodyMd_regular" style={styles.emptyText}>
            {entries.length === 0 ? t('settings.developer.logsEmpty') : t('settings.developer.logsEmptyFiltered')}
          </Typography>
        </View>
      ) : (
        <FlatList
          data={reversedEntries}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.backgroundDefault,
  },
  header: {
    padding: theme.spacing.spacing16,
    gap: theme.spacing.spacing12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.backgroundAlternative,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing12,
    marginLeft: 'auto',
  },
  title: {
    color: theme.colors.textDefault,
  },
  countBadge: {
    color: theme.colors.textAlternative,
  },
  closeButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.colors.backgroundAlternative,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButtonText: {
    color: theme.colors.textDefault,
  },
  filterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  chips: {
    flexDirection: 'row',
    gap: theme.spacing.spacing6,
  },
  chip: {
    paddingHorizontal: theme.spacing.spacing8,
    paddingVertical: theme.spacing.spacing4,
    borderRadius: theme.borderRadius.rounded4,
  },
  chipInactive: {
    backgroundColor: theme.colors.backgroundAlternative,
  },
  chipTextActive: {
    color: '#FFFFFF',
  },
  chipTextInactive: {
    color: theme.colors.textAlternative,
  },
  actionGroup: {
    flexDirection: 'row',
    gap: theme.spacing.spacing6,
  },
  copyButton: {
    paddingHorizontal: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing6,
    borderRadius: theme.borderRadius.rounded4,
    backgroundColor: theme.colors.primaryDefault,
  },
  copyButtonText: {
    color: '#FFFFFF',
  },
  clearButton: {
    paddingHorizontal: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing6,
    borderRadius: theme.borderRadius.rounded4,
    backgroundColor: '#DC2626',
  },
  clearButtonText: {
    color: '#FFFFFF',
  },
  searchInput: {
    backgroundColor: theme.colors.backgroundAlternative,
    borderRadius: theme.borderRadius.rounded8,
    paddingHorizontal: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing8,
    fontSize: theme.fontSizes.bodyMd,
    fontFamily: theme.fontFamily.regular,
    color: theme.colors.textDefault,
  },
  listContent: {
    padding: theme.spacing.spacing16,
    gap: theme.spacing.spacing8,
  },
  logRow: {
    padding: theme.spacing.spacing8,
    backgroundColor: theme.colors.backgroundAlternative,
    borderRadius: theme.borderRadius.rounded4,
    gap: theme.spacing.spacing4,
  },
  logHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing6,
  },
  timestamp: {
    color: theme.colors.textAlternative,
    fontFamily: theme.fontFamily.regular,
  },
  levelBadge: {
    paddingHorizontal: theme.spacing.spacing4,
    paddingVertical: theme.spacing.spacing2,
    borderRadius: theme.borderRadius.rounded4,
  },
  levelBadgeText: {
    color: '#FFFFFF',
    fontSize: 9,
  },
  originBadge: {
    paddingHorizontal: theme.spacing.spacing4,
    paddingVertical: theme.spacing.spacing2,
    backgroundColor: 'rgba(100, 116, 139, 0.2)',
    borderRadius: theme.borderRadius.rounded4,
  },
  originText: {
    color: theme.colors.textAlternative,
  },
  message: {
    color: theme.colors.textDefault,
  },
  metadataPreview: {
    color: theme.colors.textAlternative,
    fontFamily: theme.fontFamily.regular,
    fontSize: 10,
  },
  metadataBlock: {
    backgroundColor: 'rgba(0, 0, 0, 0.15)',
    borderRadius: theme.borderRadius.rounded4,
    padding: theme.spacing.spacing4,
  },
  metadataFull: {
    color: theme.colors.textAlternative,
    fontFamily: theme.fontFamily.regular,
    fontSize: 10,
  },
  entryActions: {
    flexDirection: 'row',
    gap: theme.spacing.spacing8,
    marginTop: theme.spacing.spacing4,
  },
  entryActionButton: {
    paddingHorizontal: theme.spacing.spacing8,
    paddingVertical: theme.spacing.spacing2,
    borderRadius: theme.borderRadius.rounded4,
    backgroundColor: 'rgba(100, 116, 139, 0.3)',
  },
  entryActionText: {
    color: theme.colors.primary300,
    fontSize: 10,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.spacing16,
  },
  emptyText: {
    color: theme.colors.textAlternative,
  },
  devActionsRow: {
    flexDirection: 'row',
    gap: theme.spacing.spacing6,
  },
  devActionButton: {
    flex: 1,
    paddingVertical: theme.spacing.spacing6,
    borderRadius: theme.borderRadius.rounded4,
    alignItems: 'center',
  },
  devActionWipe: {
    backgroundColor: '#7F1D1D',
  },
  devActionText: {
    color: '#FFFFFF',
    fontSize: 10,
  },
}))
