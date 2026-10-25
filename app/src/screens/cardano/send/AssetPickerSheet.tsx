/**
 * Asset picker — a bottom sheet listing the wallet's held native assets
 * (fungible / NFT split, searchable) for adding to a send recipient. ADA and
 * already-added assets are excluded by the caller.
 *
 * A virtualized `SectionList` (Tokens / NFTs sections) with a bounded height so
 * a token-rich wallet scrolls smoothly and only visible rows mount.
 *
 * @module
 */

import {useMemo, useState} from 'react'
import {SectionList, useWindowDimensions, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {EmptyState} from '../../../components/EmptyState'
import {Modal} from '../../../components/Modal'
import {Row} from '../../../components/Row'
import {SectionHeader} from '../../../components/SectionHeader'
import {TextInput} from '../../../components/TextInput'
import {TokenIcon} from '../../../components/TokenIcon'
import {useI18n} from '../../../providers'
import {useTokenInfos} from '../../../services/cardano-assets/hooks'
import {tokenDisplayNames} from '../../../services/cardano-assets/token-display'

const styles = StyleSheet.create(({spacing}) => ({
  search: {marginBottom: spacing.spacing12},
  section: {paddingTop: spacing.spacing12},
}))

export type AssetPickerSheetProps = {
  readonly visible: boolean
  readonly onClose: () => void
  readonly assetIds: readonly string[]
  readonly onSelect: (assetId: string) => void
  /**
   * Held ids that live in a CIP-113 smart wallet.
   *
   * Listed and refused, never omitted. A token the user can see in their portfolio and cannot
   * find here is a dead end with no explanation — and the picker is where the question is asked,
   * so it is where the answer belongs.
   */
  readonly programmableAssetIds: ReadonlySet<string>
  /**
   * Why a programmable token cannot be picked *here*. Required, because the reason genuinely
   * differs by surface: send is not built yet, swap never will be (a DEX cannot spend a
   * smart-wallet UTxO). One string covering both would over-promise in one direction.
   */
  readonly programmableReason: string
}

export const AssetPickerSheet = ({
  visible,
  onClose,
  assetIds,
  onSelect,
  programmableAssetIds,
  programmableReason,
}: AssetPickerSheetProps) => {
  const {t} = useI18n()
  const {infos} = useTokenInfos(assetIds)
  const [query, setQuery] = useState('')
  const {height} = useWindowDimensions()

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (id: string) => {
      if (q.length === 0) return true
      const info = infos.get(id)
      return (info?.label ?? id).toLowerCase().includes(q) || id.toLowerCase().includes(q)
    }
    const filtered = assetIds.filter(match)
    const tokens = filtered.filter((id) => !infos.get(id)?.isNft)
    const nfts = filtered.filter((id) => infos.get(id)?.isNft === true)
    return [
      ...(tokens.length > 0 ? [{title: t('cardanoSend.tokensSection'), data: tokens}] : []),
      ...(nfts.length > 0 ? [{title: t('cardanoSend.nftsSection'), data: nfts}] : []),
    ]
  }, [assetIds, infos, query, t])

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
      {assetIds.length === 0 ? (
        <EmptyState title={t('cardanoSend.noAssets')} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(id) => id}
          style={{maxHeight: height * 0.6}}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          stickySectionHeadersEnabled={false}
          initialNumToRender={12}
          windowSize={7}
          removeClippedSubviews
          renderSectionHeader={({section}) => (
            <View style={styles.section}>
              <SectionHeader title={section.title} />
            </View>
          )}
          renderItem={({item: id, index, section}) => {
            const info = infos.get(id)
            const {primary, secondary} = tokenDisplayNames(info)
            const programmable = programmableAssetIds.has(id)
            return (
              <Row
                leftContent={<TokenIcon assetId={id} label={primary.length > 0 ? primary : id} size={36} />}
                label={primary.length > 0 ? primary : id}
                // The fuller name when we have one; the raw id otherwise, which at
                // least tells two same-ticker tokens apart. A programmable token says why it
                // cannot be picked instead, which is the more useful thing to read.
                subtitle={programmable ? programmableReason : (secondary ?? id)}
                withBorder={index < section.data.length - 1}
                onPress={() => onSelect(id)}
                testID={`asset-pick-${id}`}
              />
            )
          }}
        />
      )}
    </Modal>
  )
}
