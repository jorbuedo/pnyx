/**
 * DRep picker — bottom sheet over the active-DRep list plus the two system
 * targets (Abstain / No confidence), which are always available and require no
 * lookup. A pasted DRep id that isn't in the list is offered as a direct
 * "use entered id" row so delegation is never limited to the indexed set.
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
import {SectionHeader} from '../../../components/SectionHeader'
import {SegmentedControl} from '../../../components/SegmentedControl'
import {TextInput} from '../../../components/TextInput'
import {UniIcon, type UniIconName} from '../../../components/UniIcon'
import {useNetworkCapabilities} from '../../../hooks/useNetworkCapabilities'
import {useFormat, useI18n} from '../../../providers'
import {
  cexplorerLogoUrl,
  type DRepListEntry,
  type DRepSortMode,
  type DRepTarget,
  drepTargetBech32,
  drepTargetsMatch,
  parseDRepTarget,
  pinFirst,
  searchDReps,
  sortDReps,
  useDRepList,
} from '../../../services/cardano-pool-drep'
import {truncateMiddle} from '../../../utils/truncate'

const ADA_DECIMALS = 6

/** What the picker hands back: the canonical target + a display label. */
export type DRepChoice = {
  readonly target: DRepTarget
  readonly label: string
}

const styles = StyleSheet.create(({spacing, colors}) => ({
  search: {marginBottom: spacing.spacing8},
  sort: {marginBottom: spacing.spacing8},
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
  section: {paddingTop: spacing.spacing8, paddingBottom: spacing.spacing4},
  systemAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.backgroundAlternative,
  },
}))

export type DrepPickerSheetProps = {
  readonly visible: boolean
  readonly onClose: () => void
  readonly onSelect: (choice: DRepChoice) => void
  /** Currently-delegated target — pinned / check-marked. */
  readonly currentTarget: DRepTarget | null
}

const SORT_MODES: readonly DRepSortMode[] = ['random', 'power', 'alpha']

/**
 * Exported so a DRep chosen somewhere other than this sheet — a delegation link,
 * for instance — reads identically to one picked here. Two truncation rules would
 * make the same DRep look like two.
 */
export const truncateDrepId = (id: string): string => truncateMiddle(id, 14, 6)
const truncateId = truncateDrepId

export const DrepPickerSheet = ({visible, onClose, onSelect, currentTarget}: DrepPickerSheetProps) => {
  const {t} = useI18n()
  const format = useFormat()
  const {adaTicker} = useNetworkCapabilities()
  const {list, loading, reload} = useDRepList()
  const {height} = useWindowDimensions()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<DRepSortMode>('random')
  const [seed, setSeed] = useState(1)

  const rows = useMemo(() => {
    if (list === null) return []
    const sorted = sortDReps(searchDReps(list, query), sort, seed)
    return pinFirst(sorted, (d) => drepTargetsMatch(parseDRepTarget(d.id), currentTarget))
  }, [list, query, sort, seed, currentTarget])

  // A pasted id that parses but isn't in the indexed list → direct-entry row.
  const pastedTarget = useMemo(() => {
    const target = parseDRepTarget(query.trim())
    if (target === null || target.kind === 'abstain' || target.kind === 'no_confidence') return null
    const inList = rows.some((d) => drepTargetsMatch(parseDRepTarget(d.id), target))
    return inList ? null : target
  }, [query, rows])

  const systemRows: readonly {
    readonly target: DRepTarget
    readonly title: string
    readonly sub: string
    readonly icon: UniIconName
  }[] = [
    {
      target: {kind: 'abstain'},
      title: t('cardanoStaking.abstain'),
      sub: t('cardanoStaking.abstainDescription'),
      icon: 'minus',
    },
    {
      target: {kind: 'no_confidence'},
      title: t('cardanoStaking.noConfidence'),
      sub: t('cardanoStaking.noConfidenceDescription'),
      icon: 'alert',
    },
  ]

  const onSortTap = (mode: DRepSortMode) => {
    if (mode === 'random' && sort === 'random') setSeed((s) => s + 1)
    setSort(mode)
  }

  const check = <UniIcon name="check" size="sm" uniProps={(theme) => ({color: theme.colors.primaryDefault})} />

  return (
    <Modal visible={visible} onClose={onClose} position="bottom" title={t('cardanoStaking.drepPickerTitle')}>
      <View style={styles.search}>
        <TextInput
          fullWidth
          placeholder={t('cardanoStaking.searchDReps')}
          value={query}
          onChange={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
      <View style={styles.sort}>
        <SegmentedControl
          options={SORT_MODES.map((mode) => ({
            label: t(`cardanoStaking.sort.${mode}` as 'cardanoStaking.sort.random'),
            value: mode,
            testID: `drep-sort-${mode}`,
          }))}
          value={sort}
          onChange={onSortTap}
        />
      </View>

      <FlatList
        data={list === null ? [] : rows}
        keyExtractor={(d) => d.id}
        style={{maxHeight: height * 0.6}}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={12}
        windowSize={7}
        removeClippedSubviews
        ListHeaderComponent={
          <>
            {systemRows.map((row) => (
              <Row
                key={row.target.kind}
                withBorder
                onPress={() => onSelect({target: row.target, label: row.title})}
                testID={`drep-pick-${row.target.kind}`}
                leftContent={
                  <View style={styles.systemAvatar}>
                    <UniIcon name={row.icon} size="sm" uniProps={(theme) => ({color: theme.colors.textAlternative})} />
                  </View>
                }
                label={row.title}
                subtitle={row.sub}
                rightContent={drepTargetsMatch(row.target, currentTarget) ? check : undefined}
              />
            ))}
            {pastedTarget !== null && (
              <Row
                withBorder
                onPress={() => {
                  const id = drepTargetBech32(pastedTarget) as string
                  onSelect({target: pastedTarget, label: truncateId(id)})
                }}
                testID="drep-pick-entered"
                leftContent={
                  <PoolDrepAvatar
                    imageUrl={cexplorerLogoUrl(drepTargetBech32(pastedTarget) ?? '')}
                    label={drepTargetBech32(pastedTarget) ?? '?'}
                  />
                }
                label={t('cardanoStaking.useEnteredId')}
                subtitle={drepTargetBech32(pastedTarget) ?? undefined}
              />
            )}
            <View style={styles.section}>
              <SectionHeader title={t('cardanoStaking.registeredDReps')} />
            </View>
          </>
        }
        ListEmptyComponent={
          loading && list === null ? (
            <View>
              {[0, 1, 2, 3, 4].map((i) => (
                <View key={i} style={styles.skelRow}>
                  <SkeletonBase show width={40} height={40} radius={20} />
                  <View style={styles.skelText}>
                    <SkeletonBase show width={150} height={14} radius={6} />
                    <SkeletonBase show width={110} height={12} radius={6} />
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
          ) : (
            <EmptyState variant="minimal" title={t('cardanoStaking.noDRepsFound')} />
          )
        }
        renderItem={({item: d}: {item: DRepListEntry}) => {
          const target = parseDRepTarget(d.id)
          return (
            <Row
              withBorder
              onPress={() => target !== null && onSelect({target, label: d.givenName ?? truncateId(d.id)})}
              testID={`drep-pick-${d.id}`}
              leftContent={
                <PoolDrepAvatar imageUrl={d.imageUrl ?? cexplorerLogoUrl(d.id)} label={d.givenName ?? d.id} />
              }
              label={d.givenName ?? truncateId(d.id)}
              subtitle={
                d.votingPower !== undefined
                  ? t('cardanoStaking.votingPowerValue', {
                      amount: format(d.votingPower, {
                        preset: 'cryptoBalance',
                        currency: adaTicker,
                        decimals: ADA_DECIMALS,
                      }),
                    })
                  : truncateId(d.id)
              }
              rightContent={drepTargetsMatch(target, currentTarget) ? check : undefined}
            />
          )
        }}
      />
    </Modal>
  )
}
