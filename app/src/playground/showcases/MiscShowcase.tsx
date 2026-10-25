/**
 * Misc Showcase.
 *
 * Demonstrates miscellaneous utility components.
 *
 * @module
 */

import {useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {BannerCardList} from '../../components/BannerCard/BannerCardList'
import {CameraScanner} from '../../components/CameraScanner'
import {ContentGroup} from '../../components/ContentGroup'
import {CountDown} from '../../components/CountDown'
import {SkeletonBase} from '../../components/Loaders/Skeleton/SkeletonBase'
import {Overlay} from '../../components/Overlay'
import {Pagination} from '../../components/Pagination'
import {RichText} from '../../components/RichText'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {SensitiveTypography} from '../../components/SensitiveTypography'
import {SettingsRow} from '../../components/SettingsRow'
import {SettingsSection} from '../../components/SettingsSection'
import {Tag} from '../../components/Tag'
import {TextInputBase} from '../../components/TextInputBase'
import {Toggle} from '../../components/Toggle'
import {Typography} from '../../components/Typography'
import {WebCameraScanner} from '../../components/WebCameraScanner'
import {ShowcaseItem, ShowcaseSection} from '../components'
import {fakeBanners} from '../data'

export const MiscShowcase = () => {
  const [currentPage, setCurrentPage] = useState(0)
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)
  const [biometricsEnabled, setBiometricsEnabled] = useState(false)

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ShowcaseSection title="Pagination" description="Page indicator dots">
        <ShowcaseItem label="5 Pages">
          <View style={styles.paginationContainer}>
            <Pagination total={5} current={currentPage} onPageChange={setCurrentPage} interactive />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="3 Pages">
          <View style={styles.paginationContainer}>
            <Pagination total={3} current={currentPage % 3} onPageChange={setCurrentPage} />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="CountDown" description="Countdown timer display">
        <ShowcaseItem label="Active">
          <CountDown targetTime={Date.now() + 3 * 24 * 60 * 60 * 1000} onComplete={() => {}} />
        </ShowcaseItem>
        <ShowcaseItem label="Short Duration">
          <CountDown targetTime={Date.now() + 2 * 60 * 60 * 1000} onComplete={() => {}} />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Content Group" description="Grouped content sections">
        <ShowcaseItem>
          <View style={styles.groupContainer}>
            <ContentGroup title="Account Details">
              <Typography variant="bodySm_regular" style={styles.groupContent}>
                Name: Main Wallet
              </Typography>
              <Typography variant="bodySm_regular" style={styles.groupContent}>
                Balance: 12,345 ADA
              </Typography>
            </ContentGroup>
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Multiple Groups">
          <View style={styles.groupContainer}>
            <ContentGroup title="Personal">
              <Typography variant="bodySm_regular" style={styles.groupContent}>
                Item 1
              </Typography>
              <Typography variant="bodySm_regular" style={styles.groupContent}>
                Item 2
              </Typography>
            </ContentGroup>
            <ContentGroup title="Settings">
              <Typography variant="bodySm_regular" style={styles.groupContent}>
                Setting A
              </Typography>
              <Typography variant="bodySm_regular" style={styles.groupContent}>
                Setting B
              </Typography>
            </ContentGroup>
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Settings Row" description="Settings list item">
        <ShowcaseItem label="Basic">
          <SettingsRow label="Language" onPress={() => {}}>
            <Typography variant="bodySm_regular" style={styles.settingsValue}>
              English
            </Typography>
          </SettingsRow>
        </ShowcaseItem>
        <ShowcaseItem label="With Description">
          <SettingsRow label="Theme" description="Choose your preferred appearance" onPress={() => {}}>
            <Typography variant="bodySm_regular" style={styles.settingsValue}>
              System
            </Typography>
          </SettingsRow>
        </ShowcaseItem>
        <ShowcaseItem label="With Icon">
          <SettingsRow label="Notifications" leftIcon="bell" onPress={() => {}}>
            <Toggle checked={notificationsEnabled} onChange={setNotificationsEnabled} />
          </SettingsRow>
        </ShowcaseItem>
        <ShowcaseItem label="With Toggle">
          <SettingsRow label="Biometric Authentication" description="Use fingerprint or face to unlock" leftIcon="lock">
            <Toggle checked={biometricsEnabled} onChange={setBiometricsEnabled} />
          </SettingsRow>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Settings Section" description="Grouped settings with title">
        <ShowcaseItem>
          <SettingsSection title="Security">
            <SettingsRow label="Change PIN" onPress={() => {}} />
            <SettingsRow label="Recovery Phrase" onPress={() => {}} />
            <SettingsRow label="Biometrics">
              <Toggle checked={biometricsEnabled} onChange={setBiometricsEnabled} />
            </SettingsRow>
          </SettingsSection>
        </ShowcaseItem>
        <ShowcaseItem label="Multiple Sections">
          <View style={styles.settingsSectionsContainer}>
            <SettingsSection title="General">
              <SettingsRow label="Language" onPress={() => {}}>
                <Typography variant="bodySm_regular" style={styles.settingsValue}>
                  English
                </Typography>
              </SettingsRow>
              <SettingsRow label="Currency" onPress={() => {}}>
                <Typography variant="bodySm_regular" style={styles.settingsValue}>
                  USD
                </Typography>
              </SettingsRow>
            </SettingsSection>
            <SettingsSection title="About">
              <SettingsRow label="Version" onPress={() => {}}>
                <Typography variant="bodySm_regular" style={styles.settingsValue}>
                  1.0.0
                </Typography>
              </SettingsRow>
              <SettingsRow label="Terms of Service" onPress={() => {}} />
            </SettingsSection>
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Chain Selector" description="Multi-chain selection">
        <ShowcaseItem label="Note">
          <View style={styles.noteContainer}>
            <Typography variant="bodySm_regular" style={styles.noteText}>
              ChainSelector uses a VirtualizedList internally and cannot be rendered inside a ScrollView. See it in
              action on the Chains screen (/chains).
            </Typography>
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Tag" description="Label tags">
        <ShowcaseItem label="Variants">
          <Tag label="Primary" variant="primary" />
          <Tag label="Secondary" variant="secondary" />
          <Tag label="Success" variant="success" />
          <Tag label="Warning" variant="warning" />
          <Tag label="Error" variant="error" />
        </ShowcaseItem>
        <ShowcaseItem label="Sizes">
          <Tag label="Small" size="sm" />
          <Tag label="Medium" size="md" />
        </ShowcaseItem>
        <ShowcaseItem label="With Icon">
          <Tag label="Verified" variant="success" icon="check" />
          <Tag label="Pending" variant="warning" icon="clock" />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Overlay" description="Background overlay blur">
        <ShowcaseItem label="Default Intensity">
          <View style={styles.overlayDemo}>
            <Typography variant="bodySm_regular" style={styles.overlayText}>
              Background Content
            </Typography>
            <Overlay onPress={() => {}} />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Higher Intensity">
          <View style={styles.overlayDemo}>
            <Typography variant="bodySm_regular" style={styles.overlayText}>
              Background Content
            </Typography>
            <Overlay intensity={10} onPress={() => {}} />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Wallet Selector" description="Modal for wallet selection">
        <ShowcaseItem label="Note">
          <View style={styles.noteContainer}>
            <Typography variant="bodySm_regular" style={styles.noteText}>
              WalletSelector requires WalletProvider context. It displays a modal with all available wallets and an "Add
              Wallet" button. See the component in action from the wallet dashboard header.
            </Typography>
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Text primitives">
        <ShowcaseItem label="TextInputBase">
          <View style={styles.summaryContainer}>
            <TextInputBase placeholder="Unstyled input base" />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="SensitiveTypography">
          <SensitiveTypography variant="bodyMd_regular">1,204.881234 ADA</SensitiveTypography>
        </ShowcaseItem>
        <ShowcaseItem label="RichText">
          <View style={styles.summaryContainer}>
            <RichText
              messageId="init.newOrReturn.consent"
              variant="bodyXs_regular"
              values={{
                terms: (chunks) => <Typography variant="bodyXs_regular">{chunks}</Typography>,
                privacy: (chunks) => <Typography variant="bodyXs_regular">{chunks}</Typography>,
              }}
            />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Skeleton base" description="Skeleton and SkeletonSquare wrap this.">
        <ShowcaseItem label="SkeletonBase" inline>
          <SkeletonBase show radius={8} width={140} height={28} />
          <SkeletonBase show radius={999} width={40} height={40} />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Banners">
        <ShowcaseItem label="BannerCardList">
          <View style={styles.summaryContainer}>
            <BannerCardList banners={fakeBanners} />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection
        title="Layout & camera"
        description="SafeAreaViewWrapper shapes a whole screen; the scanners need camera permission and report through the boundary when denied."
      >
        <ShowcaseItem label="SafeAreaViewWrapper">
          <View style={styles.overlayDemo}>
            <SafeAreaViewWrapper edges={[]}>
              <Typography variant="bodySm_regular" style={styles.overlayText}>
                Wrapped content
              </Typography>
            </SafeAreaViewWrapper>
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="CameraScanner">
          <View style={styles.overlayDemo}>
            <CameraScanner onScan={() => {}} hint="Scan a QR code" />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="WebCameraScanner">
          <View style={styles.overlayDemo}>
            <WebCameraScanner onScan={() => {}} hint="Scan a QR code" />
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
  paginationContainer: {
    alignItems: 'center',
    paddingVertical: spacing.spacing8,
  },
  groupContainer: {
    width: '100%',
    gap: spacing.spacing12,
  },
  groupContent: {
    color: colors.textDefault,
    paddingVertical: spacing.spacing4,
  },
  overlayDemo: {
    width: '100%',
    height: 100,
    backgroundColor: colors.backgroundAlternative,
    borderRadius: borderRadius.rounded12,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
    position: 'relative',
  },
  overlayText: {
    color: colors.textAlternative,
  },
  summaryContainer: {
    width: '100%',
  },
  noteContainer: {
    width: '100%',
    backgroundColor: colors.backgroundAlternative,
    borderRadius: borderRadius.rounded12,
    padding: spacing.spacing16,
  },
  noteText: {
    color: colors.textAlternative,
    lineHeight: 20,
  },
  settingsValue: {
    color: colors.textAlternative,
  },
  settingsSectionsContainer: {
    width: '100%',
    gap: spacing.spacing16,
  },
}))
