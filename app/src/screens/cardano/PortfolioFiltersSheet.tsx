/**
 * Bottom sheet holding the portfolio token filters — free-text search, the
 * Tokens / NFTs type filter, and the verified-only toggle — moved off the screen
 * body and behind the header's filter icon. Pure controlled UI: the screen owns
 * the filter state and passes it down.
 *
 * @module
 */

import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Modal} from '../../components/Modal'
import {SegmentedControl} from '../../components/SegmentedControl'
import {TextInput} from '../../components/TextInput'
import {ToggleWithLabel} from '../../components/ToggleWithLabel'
import {useI18n} from '../../providers'
import type {PortfolioAssetType} from '../../services/cardano-assets/portfolio'

export type PortfolioFiltersSheetProps = {
  readonly visible: boolean
  readonly onClose: () => void
  readonly query: string
  readonly onQueryChange: (q: string) => void
  readonly type: PortfolioAssetType
  readonly onTypeChange: (t: PortfolioAssetType) => void
  readonly showUnverified: boolean
  readonly onShowUnverifiedChange: (show: boolean) => void
}

export const PortfolioFiltersSheet = ({
  visible,
  onClose,
  query,
  onQueryChange,
  type,
  onTypeChange,
  showUnverified,
  onShowUnverifiedChange,
}: PortfolioFiltersSheetProps) => {
  const {t} = useI18n()
  return (
    <Modal visible={visible} onClose={onClose} position="bottom" title={t('cardanoPortfolio.filtersTitle')}>
      <View style={styles.body}>
        <TextInput
          fullWidth
          placeholder={t('cardanoPortfolio.searchPlaceholder')}
          value={query}
          onChange={onQueryChange}
          autoCapitalize="none"
          autoCorrect={false}
          testID="assets-search"
        />
        <SegmentedControl
          options={[
            {label: t('cardanoPortfolio.filterAll'), value: 'all'},
            {label: t('cardanoPortfolio.filterTokens'), value: 'tokens'},
            {label: t('cardanoPortfolio.filterNfts'), value: 'nfts'},
          ]}
          value={type}
          onChange={onTypeChange}
          testID="assets-type"
        />
        <ToggleWithLabel
          fullWidth
          label={t('cardanoPortfolio.verifiedOnly')}
          checked={!showUnverified}
          onChange={(checked) => onShowUnverifiedChange(!checked)}
          testID="assets-verified-toggle"
        />
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create((theme) => ({
  body: {gap: theme.spacing.spacing12, paddingBottom: theme.spacing.spacing8},
}))
