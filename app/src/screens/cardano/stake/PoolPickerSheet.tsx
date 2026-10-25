/**
 * Stake-pool picker — bottom sheet over the full pool list. Random is the
 * default sort (fair delegation exposure; seeded so the order is stable per
 * open, re-tap Random to reshuffle). `ScrollableModal` is not virtualized, so
 * the rendered list is capped and search narrows the rest.
 *
 * **On a network with no list, it asks for the id instead.** The list is an R2
 * projection that exists for mainnet only, so browsing is a mainnet convenience
 * rather than what delegation needs — the certificate is built from the pool
 * *hash*, which a `pool1…` id carries on its own. Offering a dead search box on
 * a testnet made a feature the chain supports look unavailable.
 *
 * @module
 */

import {useMemo, useState} from 'react'
import {FlatList, useWindowDimensions, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {EmptyState} from '../../../components/EmptyState'
import {SkeletonBase} from '../../../components/Loaders/Skeleton'
import {Modal} from '../../../components/Modal'
import {PoolDrepAvatar} from '../../../components/PoolDrepAvatar'
import {Row} from '../../../components/Row'
import {SegmentedControl} from '../../../components/SegmentedControl'
import {TextInput} from '../../../components/TextInput'
import {Typography} from '../../../components/Typography'
import {UniIcon} from '../../../components/UniIcon'
import {useI18n} from '../../../providers'
import {getActiveCardanoNetwork} from '../../../services/cardano/config'
import {poolKeyHashHex} from '../../../services/cardano/staking/pool-id'
import {
  cexplorerLogoUrl,
  getPoolDRepConfig,
  type PoolInfo,
  type PoolSortMode,
  pinFirst,
  searchPools,
  sortPools,
  usePoolList,
} from '../../../services/cardano-pool-drep'

const styles = StyleSheet.create(({spacing, colors}) => ({
  search: {marginBottom: spacing.spacing8},
  hint: {color: colors.textAlternative},
  sort: {marginBottom: spacing.spacing8},
  rightSlot: {flexDirection: 'row', alignItems: 'center', gap: spacing.spacing8},
  roa: {color: colors.successDefault},
  skelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.spacing12,
    paddingVertical: spacing.spacing12,
    paddingHorizontal: spacing.spacing16,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDefaultWeak,
  },
  skelText: {flex: 1, gap: spacing.spacing6},
}))

export type PoolPickerSheetProps = {
  readonly visible: boolean
  readonly onClose: () => void
  readonly onSelect: (pool: PoolInfo) => void
  /** Currently-delegated pool — pinned first and check-marked. */
  readonly currentPoolId: string | null
}

const SORT_MODES: readonly PoolSortMode[] = ['random', 'roa', 'alpha']

export const PoolPickerSheet = ({visible, onClose, onSelect, currentPoolId}: PoolPickerSheetProps) => {
  const {t} = useI18n()
  const {list, loading, reload} = usePoolList()
  const {height} = useWindowDimensions()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<PoolSortMode>('random')
  const [seed, setSeed] = useState(1)

  // A config fact, not a failed fetch: this network has no list source at all,
  // so there is nothing to retry and no reason to offer it. A mainnet outage
  // still falls through to the retry below, which is the right answer there.
  const byIdOnly = getPoolDRepConfig(getActiveCardanoNetwork()).dataUrl === undefined
  // The hash the certificate will carry, or `null` when this is not a pool id —
  // the same rule the delegation builder uses, so what this accepts and what
  // builds cannot drift apart.
  const typedPoolHash = poolKeyHashHex(query.trim())

  const rows = useMemo(() => {
    if (list === null) return []
    const active = list.filter((p) => p.status === 'active')
    const sorted = sortPools(searchPools(active, query), sort, seed)
    return pinFirst(sorted, (p) => p.id === currentPoolId)
  }, [list, query, sort, seed, currentPoolId])

  const onSortTap = (mode: PoolSortMode) => {
    // Re-tapping Random reshuffles; switching modes keeps the current seed.
    if (mode === 'random' && sort === 'random') setSeed((s) => s + 1)
    setSort(mode)
  }

  return (
    <Modal visible={visible} onClose={onClose} position="bottom" title={t('cardanoStaking.poolPickerTitle')}>
      <View style={styles.search}>
        <TextInput
          fullWidth
          placeholder={byIdOnly ? t('cardanoStaking.enterPoolId') : t('cardanoStaking.searchPools')}
          value={query}
          onChange={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          testID="pool-id-input"
        />
      </View>
      {byIdOnly && (
        <View style={styles.sort}>
          <Typography variant="bodySm_regular" style={styles.hint}>
            {t('cardanoStaking.poolIdOnlyHint')}
          </Typography>
        </View>
      )}
      {!byIdOnly && (
        <View style={styles.sort}>
          <SegmentedControl
            options={SORT_MODES.map((mode) => ({
              label: t(`cardanoStaking.sort.${mode}` as 'cardanoStaking.sort.random'),
              value: mode,
              testID: `pool-sort-${mode}`,
            }))}
            value={sort}
            onChange={onSortTap}
          />
        </View>
      )}

      {byIdOnly ? (
        <Row
          withBorder
          isDisabled={typedPoolHash === null}
          onPress={() => {
            if (typedPoolHash === null) return
            // Only what an id can honestly supply. The list is where names,
            // tickers and ROA come from, and inventing any of them here would put
            // a claim about a pool on screen that nothing checked.
            onSelect({
              id: query.trim(),
              idHex: typedPoolHash,
              status: 'active',
              logoUrl: cexplorerLogoUrl(query.trim()),
            })
          }}
          testID="pool-use-id"
          leftContent={<PoolDrepAvatar label={query.trim() || '?'} />}
          label={t('cardanoStaking.usePoolId')}
          subtitle={
            query.trim().length === 0
              ? t('cardanoStaking.poolIdEmpty')
              : typedPoolHash === null
                ? t('cardanoStaking.poolIdInvalid')
                : query.trim()
          }
        />
      ) : loading && list === null ? (
        <View>
          {[0, 1, 2, 3, 4].map((i) => (
            <View key={i} style={styles.skelRow}>
              <SkeletonBase show width={40} height={40} radius={20} />
              <View style={styles.skelText}>
                <SkeletonBase show width={150} height={14} radius={6} />
                <SkeletonBase show width={90} height={12} radius={6} />
              </View>
              <SkeletonBase show width={56} height={14} radius={6} />
            </View>
          ))}
        </View>
      ) : list === null ? (
        <EmptyState
          title={t('cardanoStaking.listUnavailable')}
          action={{label: t('common.buttons.tryAgain'), onPress: reload}}
        />
      ) : rows.length === 0 ? (
        <EmptyState variant="minimal" title={t('cardanoStaking.noPoolsFound')} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(p) => p.id}
          style={{maxHeight: height * 0.55}}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          initialNumToRender={12}
          windowSize={7}
          removeClippedSubviews
          renderItem={({item: pool}) => (
            <Row
              withBorder
              onPress={() => onSelect(pool)}
              testID={`pool-pick-${pool.id}`}
              leftContent={<PoolDrepAvatar imageUrl={pool.logoUrl} label={pool.ticker ?? pool.name ?? pool.id} />}
              label={pool.name ?? pool.id}
              subtitle={
                pool.ticker !== undefined
                  ? t('cardanoStaking.tickerLabel', {ticker: pool.ticker})
                  : pool.id.slice(0, 24)
              }
              rightContent={
                <View style={styles.rightSlot}>
                  {pool.roa !== undefined && (
                    <Typography variant="bodyMd_medium" style={styles.roa}>
                      {t('cardanoStaking.roaValue', {roa: pool.roa.toFixed(2)})}
                    </Typography>
                  )}
                  {pool.id === currentPoolId && (
                    <UniIcon name="check" size="sm" uniProps={(theme) => ({color: theme.colors.primaryDefault})} />
                  )}
                </View>
              }
            />
          )}
        />
      )}
    </Modal>
  )
}
