/**
 * Wallet Showcase.
 *
 * Balance, chain, asset and identity surfaces. Grouped so near-duplicates sit
 * next to each other — e.g. the three balance readouts, the two avatar
 * identicons, the two amount-entry rows.
 *
 * @module
 */

import {CARDANO_MAINNET, ETHEREUM_MAINNET, MIDNIGHT_MAINNET} from '@pnyx/config'
import {useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {AssetAmountRow} from '../../components/AssetAmountRow'
import {AssetMedia} from '../../components/AssetMedia'
import {BalanceBlock} from '../../components/BalanceBlock'
import {ChainRow} from '../../components/ChainRow'
import {NetworkBadge} from '../../components/NetworkBadge'
import {NetworkIcon} from '../../components/NetworkIcon'
import {NetworkNotice} from '../../components/NetworkNotice'
import {QRCard} from '../../components/QRCard'
import {QuickAction, QuickActions} from '../../components/QuickAction'
import {TokenIcon} from '../../components/TokenIcon'
import {UtxoRef} from '../../components/Utxo'
import {ValueBox} from '../../components/ValueBox'
import {WalletBalanceHero} from '../../components/WalletBalanceHero'
import {WalletGroupCard} from '../../components/WalletGroupCard'
import {ShowcaseItem, ShowcaseSection} from '../components'
import {fakeImages, fakeWalletGroupView, fakeWatchOnlyGroupView} from '../data'

const ADDRESS = 'addr1q9xy8ez8m0kfjq0dv4nrz2rl8jfvxq7q6zt5ldkr6hqhx3g8mhz6q0y3n6rk3wsz9lz3cqz5x8s2mq0kq7hn9lz'
const TX_HASH = '3c9f1b2d5e8a47c60b1d9e2f8a4c7b03d6e1f9a2c5b8d4e7f0a3c6b9d2e5f8a1c'
const ASSET_ID = 'f43a62fdc3965df486de8a0d32fe800963589c41b38946602a0dc53541474958'

export const WalletShowcase = () => {
  const [amount, setAmount] = useState('12.5')

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ShowcaseSection
        title="Balance readouts"
        description="Three components render a balance. Compare before folding."
      >
        <ShowcaseItem label="WalletBalanceHero">
          <WalletBalanceHero label="Total balance" totalFiat={{value: 4213.55, currency: 'USD'}} loading={false} />
        </ShowcaseItem>
        <ShowcaseItem label="WalletBalanceHero — loading">
          <WalletBalanceHero label="Total balance" totalFiat={null} loading />
        </ShowcaseItem>
        <ShowcaseItem label="WalletBalanceHero — unavailable">
          <WalletBalanceHero
            label="Total balance"
            totalFiat={null}
            loading={false}
            unavailable
            unavailableText="Not available"
          />
        </ShowcaseItem>
        <ShowcaseItem label="BalanceBlock">
          <BalanceBlock label="Available" amount="1,204.881234" fiat="$812.40" />
        </ShowcaseItem>
        <ShowcaseItem label="ValueBox">
          <ValueBox label="Staked" value="500.00 ADA" />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection
        title="Amount entry"
        description="PercentageRow has no consumers — the two send/swap screens hand-roll it."
      >
        <ShowcaseItem label="AssetAmountRow">
          <AssetAmountRow assetId={ASSET_ID} label="ADA" value={amount} onChangeText={setAmount} subLabel="Cardano" />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Chain surfaces">
        <ShowcaseItem label="NetworkIcon" inline>
          <NetworkIcon chain={CARDANO_MAINNET} />
          <NetworkIcon chain={MIDNIGHT_MAINNET} />
          <NetworkIcon chain={ETHEREUM_MAINNET} />
        </ShowcaseItem>
        <ShowcaseItem label="NetworkBadge — renders null on mainnet, by design">
          <NetworkBadge />
        </ShowcaseItem>
        <ShowcaseItem label="NetworkBadge compact — renders null on mainnet, by design">
          <NetworkBadge compact />
        </ShowcaseItem>
        <ShowcaseItem label="NetworkNotice — renders null on mainnet, by design">
          <NetworkNotice />
        </ShowcaseItem>
        <ShowcaseItem label="ChainRow">
          <View style={styles.full}>
            <ChainRow chain={CARDANO_MAINNET} name="Cardano" subtitle="1,204.88 ADA" onPress={() => {}} />
            <ChainRow chain={MIDNIGHT_MAINNET} name="Midnight" subtitle="Identity" />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Asset surfaces">
        <ShowcaseItem label="TokenIcon" inline>
          <TokenIcon assetId={ASSET_ID} label="SNEK" />
          <TokenIcon assetId={ASSET_ID} label="SNEK" size={48} />
        </ShowcaseItem>
        <ShowcaseItem label="AssetMedia" inline>
          <AssetMedia image={fakeImages.pink} />
          <AssetMedia image={fakeImages.amber} size={72} />
          <AssetMedia />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Wallet cards">
        <ShowcaseItem label="WalletGroupCard">
          <View style={styles.full}>
            <WalletGroupCard group={fakeWalletGroupView} isActive onPress={() => {}} />
            <WalletGroupCard group={fakeWatchOnlyGroupView} isActive={false} onPress={() => {}} />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Actions">
        <ShowcaseItem label="QuickAction" inline>
          <QuickAction icon="send" label="Send" onPress={() => {}} />
          <QuickAction icon="receive" label="Receive" onPress={() => {}} />
        </ShowcaseItem>
        <ShowcaseItem label="QuickActions">
          <QuickActions
            actions={[
              {key: 'send', icon: 'send', label: 'Send', onPress: () => {}},
              {key: 'receive', icon: 'receive', label: 'Receive', onPress: () => {}},
              {key: 'swap', icon: 'swap', label: 'Swap', onPress: () => {}},
              {key: 'scan', icon: 'scan', label: 'Scan', onPress: () => {}},
            ]}
          />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Receive / UTxO">
        <ShowcaseItem label="QRCard">
          <QRCard value={ADDRESS} size={160} />
        </ShowcaseItem>
        <ShowcaseItem label="UtxoRef">
          <View style={styles.full}>
            {/* No explorer link in the showcase: it renders the component, not a live chain. */}
            <UtxoRef
              txHashHex={TX_HASH}
              index={0}
              address={ADDRESS}
              derivationPath="m/1852'/1815'/0'/0/0"
              explorerUrl={null}
            />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>
    </ScrollView>
  )
}

const styles = StyleSheet.create(({spacing}) => ({
  container: {
    flex: 1,
  },
  content: {
    paddingVertical: spacing.spacing16,
    gap: spacing.spacing24,
  },
  full: {
    width: '100%',
    gap: spacing.spacing8,
  },
}))
