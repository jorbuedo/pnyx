/**
 * Swap token picker — the "to" side of a swap picks from the full SteelSwap
 * tradeable universe (~5.5k tokens), not just held assets, so a user can buy a
 * token they do not yet own. ADA is pinned first; the rest render in SteelSwap's
 * popularity order, filtered by search (ticker / name / policy).
 *
 * The list is a virtualized `FlatList` with a bounded height so the full
 * universe scrolls smoothly and only the visible rows (and their icons) mount.
 * Selecting returns the full token so the caller keeps its decimals + label
 * without a metadata fetch.
 *
 * @module
 */

import {useMemo, useState} from 'react'
import {FlatList, useWindowDimensions, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {EmptyState} from '../../components/EmptyState'
import {CircleLoader} from '../../components/Loaders'
import {Modal} from '../../components/Modal'
import {Row} from '../../components/Row'
import {TextInput} from '../../components/TextInput'
import {TokenIcon} from '../../components/TokenIcon'
import {useTradeableTokens} from '../../hooks/useTradeableTokens'
import {useI18n} from '../../providers'
import type {TradeableToken} from '../../services/cardano-swap/token-universe'

const ADA_TOKEN: TradeableToken = {assetId: '', ticker: 'ADA', name: 'Cardano', decimals: 6}
const rowKey = (tk: TradeableToken) => (tk.assetId === '' ? 'ada' : tk.assetId)

const styles = StyleSheet.create(({spacing}) => ({
  search: {marginBottom: spacing.spacing12},
  state: {paddingVertical: spacing.spacing24, alignItems: 'center'},
}))

export type SwapTokenPickerSheetProps = {
  readonly visible: boolean
  readonly onClose: () => void
  readonly onSelect: (token: TradeableToken) => void
  /** Hide this asset id from the list (the opposite side of the pair). */
  readonly excludeId?: string
}

export const SwapTokenPickerSheet = ({visible, onClose, onSelect, excludeId}: SwapTokenPickerSheetProps) => {
  const {t} = useI18n()
  const {tokens, loading} = useTradeableTokens()
  const [query, setQuery] = useState('')
  const {height} = useWindowDimensions()

  /**
   * Filtered LOCALLY, on purpose. The curated set is already cached in full
   * (~6k tokens, 24 h TTL, in liquidity order, which filtering preserves), so a
   * server round-trip would buy nothing and cost a request against a **100/day
   * per-key quota**. It would also be slower and would not work offline.
   *
   * The one thing server search adds is reaching UNVERIFIED tokens — and the
   * portfolio treats unverified as spam, so putting them in a swap picker is a
   * product decision, not a search improvement.
   */
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = [ADA_TOKEN, ...tokens].filter((tk) => tk.assetId !== excludeId)
    if (q.length === 0) return all
    return all.filter(
      (tk) =>
        tk.ticker.toLowerCase().includes(q) ||
        tk.name.toLowerCase().includes(q) ||
        tk.assetId.toLowerCase().includes(q),
    )
  }, [tokens, query, excludeId])

  return (
    <Modal visible={visible} onClose={onClose} position="bottom" title={t('cardanoSend.assetPickerTitle')}>
      <View style={styles.search}>
        <TextInput
          fullWidth
          placeholder={t('cardanoSend.searchAssets')}
          value={query}
          onChange={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
      {loading ? (
        <View style={styles.state}>
          <CircleLoader />
        </View>
      ) : shown.length === 0 ? (
        <EmptyState title={t('cardanoSend.noAssets')} />
      ) : (
        <FlatList
          data={shown}
          keyExtractor={rowKey}
          style={{maxHeight: height * 0.6}}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          initialNumToRender={12}
          windowSize={7}
          removeClippedSubviews
          renderItem={({item, index}) => (
            <Row
              leftContent={<TokenIcon assetId={item.assetId} label={item.ticker || item.name} size={36} />}
              label={item.ticker || item.name || item.assetId}
              subtitle={item.name || item.assetId}
              withBorder={index < shown.length - 1}
              onPress={() => onSelect(item)}
              testID={`swap-token-pick-${rowKey(item)}`}
            />
          )}
        />
      )}
    </Modal>
  )
}
