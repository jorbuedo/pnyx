/**
 * Row Showcase.
 *
 * Demonstrates row layouts and data display components.
 *
 * @module
 */

import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {IdentityAvatar} from '../../components/IdentityAvatar'
import {DataRow, Row} from '../../components/Row'
import {ActivityRow} from '../../screens/cardano/HistoryScreen'
import {DeviceRow} from '../../screens/hardware/HardwarePairScreen'
import {ChannelRow} from '../../screens/home/ChannelPanel'
import {ShowcaseItem, ShowcaseSection} from '../components'
import {FAKE_NOW_MS, fakePendingTx, fakeReceivedTx, fakeSentTx} from '../data'

/** ADA, as the token-metadata service would report it. */
const ADA_INFO = {id: '', decimals: 6, label: 'ADA', ticker: 'ADA', isNft: false, known: true, hasIcon: false} as const

export const RowShowcase = () => {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ShowcaseSection title="Row" description="Flexible row layout component">
        <ShowcaseItem label="Basic">
          <View style={styles.rowContainer}>
            <Row label="Primary Label" subtitle="Secondary text" rightIcon="chevronRight" />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="With Left Content">
          <View style={styles.rowContainer}>
            <Row
              leftContent={<IdentityAvatar size={32} pnyxId="a3f9c2e1b8d47506" />}
              label="My Wallet"
              subtitle="$1,234.56"
              rightIcon="chevronRight"
              onPress={() => {}}
            />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Multiple Rows">
          <View style={styles.rowContainer}>
            <Row leftContent={<IdentityAvatar size={32} pnyxId="a3f9c2e1b8d47506" />} label="Account 1" withBorder />
            <Row leftContent={<IdentityAvatar size={32} pnyxId="a3f9c2e1b8d47506" />} label="Account 2" withBorder />
            <Row leftContent={<IdentityAvatar size={32} pnyxId="a3f9c2e1b8d47506" />} label="Account 3" />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Data Row" description="Key-value pair display">
        <ShowcaseItem label="Basic">
          <View style={styles.rowContainer}>
            <DataRow label="Network Fee" value="0.17 ADA" />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Multiple Rows">
          <View style={styles.rowContainer}>
            <DataRow label="From" value="addr1qx2kd28nq..." withBorder />
            <DataRow label="To" value="addr1qx7890abc..." withBorder />
            <DataRow label="Amount" value="100.00 ADA" withBorder />
            <DataRow label="Fee" value="0.17 ADA" />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Loading">
          <View style={styles.rowContainer}>
            <DataRow label="Balance" isLoading />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>
      <ShowcaseSection
        title="Screen-local rows"
        description="Defined inside screens rather than components/, so they were never in the inventory. Kept rather than folded — each is domain- or density-specific, not a copy of Row."
      >
        <ShowcaseItem label="ChannelRow — compact, has press feedback">
          <View style={styles.rowContainer}>
            <ChannelRow name="general" description="Anything and everything" onPress={() => {}} testID="pg-channel" />
            <ChannelRow name="treasury" description="Spending proposals" onPress={() => {}} testID="pg-channel-2" />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="DeviceRow — built on Card, not Row">
          <View style={styles.rowContainer}>
            <DeviceRow
              title="Ledger Nano X"
              meta="Connected over USB"
              icon="ledger"
              disabled={false}
              loading={false}
              onPress={() => {}}
              testID="pg-device"
            />
            <DeviceRow
              title="Trezor Safe 3"
              meta="Pairing…"
              icon="trezor"
              disabled
              loading
              onPress={() => {}}
              testID="pg-device-2"
            />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="ActivityRow — 175 lines of transaction domain">
          <View style={styles.rowContainer}>
            <ActivityRow
              tx={fakeSentTx}
              isFirst
              isLast={false}
              onPress={() => {}}
              infoFor={() => ADA_INFO}
              fiatOf={null}
              showDate
              nowMs={FAKE_NOW_MS}
            />
            <ActivityRow
              tx={fakeReceivedTx}
              isFirst={false}
              isLast={false}
              onPress={() => {}}
              infoFor={() => ADA_INFO}
              fiatOf={null}
            />
            <ActivityRow
              tx={fakePendingTx}
              isFirst={false}
              isLast
              onPress={() => {}}
              infoFor={() => ADA_INFO}
              fiatOf={null}
            />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>
    </ScrollView>
  )
}

const styles = StyleSheet.create(({colors, spacing, borderRadius}) => ({
  container: {
    flex: 1,
  },
  content: {
    paddingVertical: spacing.spacing16,
    gap: spacing.spacing24,
  },
  rowContainer: {
    width: '100%',
    backgroundColor: colors.backgroundAlternative,
    borderRadius: borderRadius.rounded12,
    padding: spacing.spacing12,
  },
  cellContainer: {
    gap: spacing.spacing12,
  },
}))
