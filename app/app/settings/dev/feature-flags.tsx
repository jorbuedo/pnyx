/**
 * Feature flags debug panel.
 *
 * Provides comprehensive view and control over all feature flags:
 * - Current state and source for each flag
 * - Toggle switches for runtime overrides
 * - Clear individual or all overrides
 * - Audit trail of recent evaluations
 *
 * @module
 */

import type {FeatureFlagAuditEntry, FeatureFlagEvaluation, FeatureFlagId} from '@pnyx/config'
import {Effect} from 'effect'
import {useCallback, useEffect, useState} from 'react'
import {Alert, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Button} from '../../../src/components/Buttons'
import {SafeAreaViewWrapper} from '../../../src/components/SafeAreaViewWrapper'
import {Toggle} from '../../../src/components/Toggle'
import {Typography} from '../../../src/components/Typography'
import {useFeatureFlagEvaluation} from '../../../src/hooks/useFeatureFlag'
import {useConfig, useI18n} from '../../../src/providers'

/**
 * Section grouping for every feature flag, keyed exhaustively by
 * `FeatureFlagId`. Adding a new id to the union without adding it here
 * is a TypeScript error — the dev UI list is derived from this record,
 * so it can't drift from the source of truth.
 */
const FLAG_SECTIONS: Record<FeatureFlagId, string> = {
  // Core features
  addWallet: 'Core',
  // Onboarding flows
  createWallet: 'Onboarding',
  restoreWallet: 'Onboarding',
  // Additional features
  discover: 'Additional',
  pushNotifications: 'Additional',
  encryptedBackupExport: 'Additional',
  // One flag for every chart surface: Home portfolio widget, Portfolio tab,
  // per-asset sparklines, token detail — they all share one data spine.
  portfolioChart: 'Additional',
  // The handles vertical: claiming a name on chain, the permit storefront, tiers, rebind, release.
  // Off for the mainnet launch, which ships the nickname layer alone; on in dev and preview against
  // preprod, where the payment contract and handle templates exist.
  handles: 'Additional',
  // Held out of production while the SteelSwap integration is unfinished.
  swap: 'Additional',
  // Developer tools
  devTools: 'Developer tools',
}

const ALL_FLAG_IDS: readonly FeatureFlagId[] = (Object.keys(FLAG_SECTIONS) as FeatureFlagId[])
  .slice()
  .sort((a, b) => a.localeCompare(b))

/**
 * Source badge color mapping.
 */
const SOURCE_COLORS: Record<FeatureFlagEvaluation['source'], string> = {
  runtime: '#DC2626', // Red
  remote: '#7C3AED', // Purple
  environment: '#059669', // Green
  platform: '#D97706', // Amber
  code: '#64748B', // Gray
}

/**
 * Individual feature flag row.
 */
export function FeatureFlagRow({flagId}: {flagId: FeatureFlagId}) {
  const {featureFlagsService} = useConfig()
  const {enabled, source, loading} = useFeatureFlagEvaluation(flagId)
  const {t} = useI18n()
  const [isToggling, setIsToggling] = useState(false)

  const handleToggle = useCallback(
    async (newValue: boolean) => {
      if (!featureFlagsService || isToggling) return

      setIsToggling(true)
      try {
        await Effect.runPromise(featureFlagsService.setRuntimeOverride(flagId, newValue))
      } catch (error) {
        console.error(`[FeatureFlagsDebug] Failed to set override for ${flagId}:`, error)
        Alert.alert(t('settings.developer.flagErrorTitle'), t('settings.developer.flagOverrideFailed', {flagId}))
      } finally {
        setIsToggling(false)
      }
    },
    [featureFlagsService, flagId, isToggling, t],
  )

  const handleClear = useCallback(async () => {
    if (!featureFlagsService) return

    try {
      await Effect.runPromise(featureFlagsService.clearRuntimeOverride(flagId))
    } catch (error) {
      console.error(`[FeatureFlagsDebug] Failed to clear override for ${flagId}:`, error)
      Alert.alert(t('settings.developer.flagErrorTitle'), t('settings.developer.flagClearOverrideFailed', {flagId}))
    }
  }, [featureFlagsService, flagId, t])

  if (loading) {
    return (
      <View style={styles.flagRow}>
        <Typography variant="bodyMd_regular">{t('common.labels.loading')}</Typography>
      </View>
    )
  }

  const sourceColor = SOURCE_COLORS[source] || SOURCE_COLORS.code

  return (
    <View style={styles.flagRow}>
      <View style={styles.flagInfo}>
        <View style={styles.flagHeader}>
          <Typography variant="bodyMd_medium">{flagId}</Typography>
          <View style={[styles.sourceBadge, {backgroundColor: sourceColor}]}>
            <Typography variant="bodyXs_medium" style={styles.sourceBadgeText}>
              {source}
            </Typography>
          </View>
        </View>
        <Typography variant="bodyXs_regular" style={styles.flagStatus}>
          {enabled ? t('settings.developer.flagEnabled') : t('settings.developer.flagDisabled')}
        </Typography>
      </View>
      <View style={styles.flagActions}>
        {source === 'runtime' && (
          <Button
            label={t('settings.developer.flagClearOverride')}
            variant="secondary"
            size="sm"
            onPress={handleClear}
            testID={`clear-${flagId}`}
          />
        )}
        <Toggle checked={enabled} onChange={handleToggle} disabled={isToggling} testID={`toggle-${flagId}`} />
      </View>
    </View>
  )
}

/**
 * Audit trail section.
 */
function AuditTrail() {
  const {featureFlagsService} = useConfig()
  const {t} = useI18n()
  const [trail, setTrail] = useState<readonly FeatureFlagAuditEntry[]>([])

  useEffect(() => {
    if (!featureFlagsService) return

    let mounted = true

    const loadTrail = () => {
      Effect.runPromise(featureFlagsService.getAuditTrail())
        .then((trail) => {
          if (mounted) setTrail(trail)
        })
        .catch((error) => {
          console.error('[FeatureFlagsDebug] Failed to load audit trail:', error)
        })
    }

    // Load initial trail
    loadTrail()

    // Update trail periodically
    const interval = setInterval(loadTrail, 5000)

    return () => {
      mounted = false
      clearInterval(interval)
    }
  }, [featureFlagsService])

  if (trail.length === 0) {
    return (
      <View style={styles.auditEmpty}>
        <Typography variant="bodyMd_regular" style={styles.auditEmptyText}>
          {t('settings.developer.flagsAuditEmpty')}
        </Typography>
      </View>
    )
  }

  return (
    <View style={styles.auditContainer}>
      {trail
        .slice(-10)
        .reverse()
        .map((entry, index) => {
          const sourceColor = SOURCE_COLORS[entry.source] || SOURCE_COLORS.code
          return (
            <View key={`${entry.flagId}-${entry.evaluatedAt}-${index}`} style={styles.auditEntry}>
              <View style={styles.auditHeader}>
                <Typography variant="bodyXs_medium">{entry.flagId}</Typography>
                <View style={[styles.auditBadge, {backgroundColor: sourceColor}]}>
                  <Typography variant="bodyXs_regular" style={styles.auditBadgeText}>
                    {entry.source}
                  </Typography>
                </View>
              </View>
              <Typography variant="bodyXs_regular" style={styles.auditStatus}>
                {entry.enabled ? t('settings.developer.flagEnabled') : t('settings.developer.flagDisabled')} •{' '}
                {new Date(entry.evaluatedAt).toLocaleTimeString()}
              </Typography>
            </View>
          )
        })}
    </View>
  )
}

/**
 * Feature flags debug panel screen.
 */
export default function FeatureFlagsDebugScreen() {
  const {featureFlagsService} = useConfig()
  const {t} = useI18n()

  const handleClearAll = useCallback(() => {
    if (!featureFlagsService) return

    Alert.alert(t('settings.developer.flagClearAllTitle'), t('settings.developer.flagClearAllMessage'), [
      {text: t('common.buttons.cancel'), style: 'cancel'},
      {
        text: t('settings.developer.flagClearAllConfirm'),
        style: 'destructive',
        onPress: async () => {
          try {
            await Effect.runPromise(featureFlagsService.clearAllRuntimeOverrides())
            Alert.alert(
              t('settings.developer.flagClearAllSuccessTitle'),
              t('settings.developer.flagClearAllSuccessMessage'),
            )
          } catch (error) {
            console.error('[FeatureFlagsDebug] Failed to clear all overrides:', error)
            Alert.alert(t('settings.developer.flagErrorTitle'), t('settings.developer.flagClearAllErrorMessage'))
          }
        },
      },
    ])
  }, [featureFlagsService, t])

  return (
    <SafeAreaViewWrapper
      style={styles.safeArea}
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.scrollContent}
    >
      {/* Header */}
      <View style={styles.header}>
        <Typography variant="headingMd" style={styles.title}>
          {t('settings.developer.flagsScreenTitle')}
        </Typography>
        <Typography variant="bodyMd_regular" style={styles.description}>
          {t('settings.developer.flagsScreenDescription')}
        </Typography>
        <Button
          label={t('settings.developer.flagsClearAllButton')}
          variant="secondary"
          onPress={handleClearAll}
          testID="clear-all-button"
        />
      </View>

      {/* Legend */}
      <View style={styles.legend}>
        <Typography variant="bodyMd_medium" style={styles.legendTitle}>
          {t('settings.developer.flagsSourcePriority')}
        </Typography>
        <View style={styles.legendItems}>
          {Object.entries(SOURCE_COLORS).map(([source, color]) => (
            <View key={source} style={styles.legendItem}>
              <View style={[styles.legendDot, {backgroundColor: color}]} />
              <Typography variant="bodyXs_regular">{source}</Typography>
            </View>
          ))}
        </View>
      </View>

      {/* Feature Flags */}
      <View style={styles.section}>
        <Typography variant="bodyLg_medium" style={styles.sectionTitle}>
          {t('settings.developer.flagsAllFlags')}
        </Typography>
        {ALL_FLAG_IDS.map((flagId) => (
          <FeatureFlagRow key={flagId} flagId={flagId} />
        ))}
      </View>

      {/* Audit Trail */}
      <View style={styles.section}>
        <Typography variant="bodyLg_medium" style={styles.sectionTitle}>
          {t('settings.developer.flagsRecentEvaluations')}
        </Typography>
        <AuditTrail />
      </View>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: theme.spacing.spacing16,
    gap: theme.spacing.spacing16,
  },
  header: {
    gap: theme.spacing.spacing12,
  },
  title: {
    color: theme.colors.textDefault,
  },
  description: {
    color: theme.colors.textAlternative,
    lineHeight: 20,
  },
  legend: {
    gap: theme.spacing.spacing8,
    padding: theme.spacing.spacing12,
    backgroundColor: theme.colors.backgroundAlternative,
    borderRadius: theme.borderRadius.rounded8,
  },
  legendTitle: {
    color: theme.colors.textDefault,
  },
  legendItems: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.spacing12,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing4,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  section: {
    gap: theme.spacing.spacing12,
  },
  sectionTitle: {
    color: theme.colors.textDefault,
  },
  flagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: theme.spacing.spacing12,
    backgroundColor: theme.colors.backgroundAlternative,
    borderRadius: theme.borderRadius.rounded8,
    gap: theme.spacing.spacing12,
  },
  flagInfo: {
    flex: 1,
    gap: theme.spacing.spacing4,
  },
  flagHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing8,
  },
  flagStatus: {
    color: theme.colors.textAlternative,
  },
  sourceBadge: {
    paddingHorizontal: theme.spacing.spacing6,
    paddingVertical: theme.spacing.spacing2,
    borderRadius: theme.borderRadius.rounded4,
  },
  sourceBadgeText: {
    color: '#FFFFFF',
    textTransform: 'uppercase',
  },
  flagActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing8,
  },
  auditContainer: {
    gap: theme.spacing.spacing8,
  },
  auditEntry: {
    padding: theme.spacing.spacing8,
    backgroundColor: theme.colors.backgroundAlternative,
    borderRadius: theme.borderRadius.rounded4,
    gap: theme.spacing.spacing4,
  },
  auditHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  auditBadge: {
    paddingHorizontal: theme.spacing.spacing4,
    paddingVertical: theme.spacing.spacing2,
    borderRadius: theme.borderRadius.rounded4,
  },
  auditBadgeText: {
    color: '#FFFFFF',
    textTransform: 'uppercase',
  },
  auditStatus: {
    color: theme.colors.textAlternative,
  },
  auditEmpty: {
    padding: theme.spacing.spacing16,
    alignItems: 'center',
  },
  auditEmptyText: {
    color: theme.colors.textAlternative,
  },
}))
