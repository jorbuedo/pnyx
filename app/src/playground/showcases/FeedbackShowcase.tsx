/**
 * Feedback Showcase.
 *
 * Demonstrates feedback and status indicator components.
 *
 * @module
 */

import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Badge} from '../../components/Badge'
import {Callout} from '../../components/Callout'
import {EmptyState} from '../../components/EmptyState'
import {Toast} from '../../components/Toast'
import {WarningMessage} from '../../components/WarningMessage'
import {ShowcaseItem, ShowcaseSection} from '../components'

export const FeedbackShowcase = () => {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ShowcaseSection title="Toast" description="Temporary notification messages">
        <ShowcaseItem label="Success">
          <View style={styles.toastContainer}>
            <Toast variant="success" message="Transaction submitted successfully!" />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Error">
          <View style={styles.toastContainer}>
            <Toast variant="error" message="Failed to connect to network" />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Warning">
          <View style={styles.toastContainer}>
            <Toast variant="warning" message="Low balance warning" />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Info">
          <View style={styles.toastContainer}>
            <Toast variant="info" message="Syncing wallet data..." />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Banner" description="Persistent notification banners">
        <ShowcaseItem label="Info">
          <Callout variant="info" message="Your wallet is now synced with the latest blocks" />
        </ShowcaseItem>
        <ShowcaseItem label="Warning">
          <Callout variant="warning" message="Network congestion detected. Transactions may be delayed." />
        </ShowcaseItem>
        <ShowcaseItem label="Error">
          <Callout variant="error" message="Unable to connect to the blockchain. Please check your connection." />
        </ShowcaseItem>
        <ShowcaseItem label="Success">
          <Callout variant="success" message="All systems operational" />
        </ShowcaseItem>
        <ShowcaseItem label="With Action">
          <Callout variant="info" message="New app version available" actionLabel="Update" onAction={() => {}} />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Badge" description="Status indicators and counts">
        <ShowcaseItem label="Status Dots">
          <Badge status="success" />
          <Badge status="warning" />
          <Badge status="error" />
          <Badge status="primary" />
          <Badge status="muted" />
        </ShowcaseItem>
        <ShowcaseItem label="With Icon">
          <Badge icon="notification" size="sm" />
          <Badge icon="check" size="md" />
          <Badge icon="bell" size="lg" />
        </ShowcaseItem>
        <ShowcaseItem label="Network Count">
          <Badge networkCount={3} size="sm" />
          <Badge networkCount={12} size="md" />
          <Badge networkCount={100} size="lg" />
        </ShowcaseItem>
        <ShowcaseItem label="Sizes">
          <Badge icon="notification" size="sm" />
          <Badge icon="notification" size="md" />
          <Badge icon="notification" size="lg" />
          <Badge icon="notification" size="xl" />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Warning Message" description="Inline warning text">
        <ShowcaseItem label="Default">
          <WarningMessage label="Please backup your recovery phrase" />
        </ShowcaseItem>
        <ShowcaseItem label="Warning">
          <WarningMessage variant="warning" label="Transaction fees may vary based on network load" />
        </ShowcaseItem>
        <ShowcaseItem label="Error">
          <WarningMessage variant="error" label="Insufficient balance for this transaction" />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Empty State" description="Placeholder for empty content">
        <ShowcaseItem label="Default">
          <View style={styles.emptyStateContainer}>
            <EmptyState
              icon="email"
              title="No transactions yet"
              description="Your transaction history will appear here"
            />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="With Action">
          <View style={styles.emptyStateContainer}>
            <EmptyState
              icon="wallet"
              title="No wallets found"
              description="Create or import a wallet to get started"
              action={{label: 'Add Wallet', onPress: () => {}}}
            />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Minimal">
          <View style={styles.emptyStateContainer}>
            <EmptyState variant="minimal" title="No results" />
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
  toastContainer: {
    width: '100%',
  },
  emptyStateContainer: {
    width: '100%',
    minHeight: 200,
    backgroundColor: colors.backgroundAlternative,
    borderRadius: borderRadius.rounded12,
    justifyContent: 'center',
    alignItems: 'center',
  },
}))
