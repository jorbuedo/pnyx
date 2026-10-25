/**
 * Display Showcase.
 *
 * Demonstrates display and typography components.
 *
 * @module
 */

import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Accordion} from '../../components/Accordion'
import {Address} from '../../components/Address'
import {Copiable} from '../../components/Copiable'
import {Image} from '../../components/Image'
import {PnyxLogomark, PnyxPortraitLogo, PnyxPrimaryLogo} from '../../components/illustrations'
import {GradientEffect, MinimalLine} from '../../components/patterns'
import {QRCode} from '../../components/QRCode'
import {Typography} from '../../components/Typography'
import {truncateWide} from '../../utils/truncate'
import {ShowcaseItem, ShowcaseSection} from '../components'
import {fakeAddresses, fakeImages} from '../data'

export const DisplayShowcase = () => {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ShowcaseSection title="Typography" description="Text styling variants">
        <ShowcaseItem label="Headings">
          <View style={styles.typographyContainer}>
            <Typography variant="headingLg">Heading Large</Typography>
            <Typography variant="headingMd">Heading Medium</Typography>
            <Typography variant="headingSm">Heading Small</Typography>
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Display">
          <View style={styles.typographyContainer}>
            <Typography variant="displayLg">Display Large</Typography>
            <Typography variant="displayMd">Display Medium</Typography>
            <Typography variant="displaySm">Display Small</Typography>
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Body">
          <View style={styles.typographyContainer}>
            <Typography variant="bodyLg_regular">Body Large Regular</Typography>
            <Typography variant="bodyMd_regular">Body Medium Regular</Typography>
            <Typography variant="bodySm_regular">Body Small Regular</Typography>
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Weights">
          <View style={styles.typographyContainer}>
            <Typography variant="bodyMd_regular">Regular Weight</Typography>
            <Typography variant="bodyMd_medium">Medium Weight</Typography>
            <Typography variant="bodyMd_bold">Bold Weight</Typography>
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Single Line (truncate)">
          <View style={styles.typographyContainer}>
            <Typography variant="bodyMd_regular" singleLine>
              This is a very long text that will be truncated because it doesn't fit on a single line
            </Typography>
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="New Typography Variants" description="headingXl, displayXs, displayXl — later additions">
        <ShowcaseItem label="headingXl (20/32)">
          <View style={styles.typographyContainer}>
            <Typography variant="headingXl">Heading Extra Large</Typography>
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="displayXs (34/40)">
          <View style={styles.typographyContainer}>
            <Typography variant="displayXs">Display Extra Small</Typography>
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="displayXl (58/70)">
          <View style={styles.typographyContainer}>
            <Typography variant="displayXl">Display XL</Typography>
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="displayLg fixed (56/66, was 54/70)">
          <View style={styles.typographyContainer}>
            <Typography variant="displayLg">Display Large</Typography>
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Letter Spacing" description="bodyXs variants carry letterSpacing.xs (0.25px)">
        <ShowcaseItem label="bodyXs_regular — with letterSpacing.xs">
          <View style={styles.typographyContainer}>
            <Typography variant="bodyXs_regular">The quick brown fox jumps over the lazy dog</Typography>
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="bodyXs_medium — with letterSpacing.xs">
          <View style={styles.typographyContainer}>
            <Typography variant="bodyXs_medium">The quick brown fox jumps over the lazy dog</Typography>
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="bodySm_regular — no letter spacing (baseline)">
          <View style={styles.typographyContainer}>
            <Typography variant="bodySm_regular">The quick brown fox jumps over the lazy dog</Typography>
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Accordion" description="Expandable content sections">
        <ShowcaseItem>
          <View style={styles.accordionContainer}>
            <Accordion title="What is staking?">
              <Typography variant="bodySm_regular">
                Staking is the process of delegating your ADA to a stake pool to help secure the network and earn
                rewards. Your ADA never leaves your wallet.
              </Typography>
            </Accordion>
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Multiple">
          <View style={styles.accordionContainer}>
            <Accordion title="How do rewards work?">
              <Typography variant="bodySm_regular">
                Rewards are distributed every epoch (approximately 5 days) based on the performance of your stake pool.
              </Typography>
            </Accordion>
            <Accordion title="Can I unstake anytime?">
              <Typography variant="bodySm_regular">
                Yes, you can unstake at any time. There is no lock-up period for staked ADA.
              </Typography>
            </Accordion>
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="QR Code" description="QR code generation">
        <ShowcaseItem label="Address">
          <View style={styles.qrContainer}>
            <QRCode value={fakeAddresses.cardano.mainnet} size={150} />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Different Sizes">
          <View style={styles.qrRow}>
            <QRCode value="small" size={80} />
            <QRCode value="medium" size={120} />
            <QRCode value="large" size={160} />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Copiable" description="Text with copy functionality">
        <ShowcaseItem>
          <Copiable text={fakeAddresses.cardano.mainnet}>
            <Typography variant="bodySm_regular">{truncateWide(fakeAddresses.cardano.mainnet)}</Typography>
          </Copiable>
        </ShowcaseItem>
        <ShowcaseItem label="With Title">
          <Copiable text="abc123def456789" title="Transaction Hash">
            <Typography variant="bodySm_regular">abc123def456789</Typography>
          </Copiable>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Address" description="Blockchain address display">
        <ShowcaseItem label="Default">
          <Address address={fakeAddresses.cardano.mainnet} />
        </ShowcaseItem>
        <ShowcaseItem label="Without Modal">
          <Address address={fakeAddresses.cardano.mainnet} showModal={false} />
        </ShowcaseItem>
        <ShowcaseItem label="Different Addresses">
          <View style={styles.addressContainer}>
            <Address address={fakeAddresses.ethereum} />
            <Address address={fakeAddresses.bitcoin} />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Image" description="Image display component">
        <ShowcaseItem label="Image (data URI)">
          <Image source={{uri: fakeImages.blue}} width={150} height={150} />
        </ShowcaseItem>
        <ShowcaseItem label="Different Sizes">
          <View style={styles.imageRow}>
            <Image source={{uri: fakeImages.green}} width={50} height={50} />
            <Image source={{uri: fakeImages.amber}} width={80} height={80} />
            <Image source={{uri: fakeImages.pink}} width={120} height={120} />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Rounded">
          <Image source={{uri: fakeImages.blue}} width={100} height={100} style={{borderRadius: 50}} />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Pnyx Logos" description="Pnyx branded logo variants">
        <ShowcaseItem label="Primary — light">
          <View style={[styles.logoPreview, styles.logoDark]}>
            <PnyxPrimaryLogo width={200} variant="light" />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Primary — dark">
          <View style={[styles.logoPreview, styles.logoLight]}>
            <PnyxPrimaryLogo width={200} variant="dark" />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Logomark">
          <View style={styles.logoContainer}>
            <PnyxLogomark width={64} />
            <PnyxLogomark width={92} />
            <PnyxLogomark width={184} />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Portrait — light">
          <View style={[styles.logoPreview, styles.logoDark]}>
            <PnyxPortraitLogo width={200} variant="light" />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Portrait — dark">
          <View style={[styles.logoPreview, styles.logoLight]}>
            <PnyxPortraitLogo width={200} variant="dark" />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Patterns & Effects" description="Pnyx brand visual primitives">
        <ShowcaseItem label="GradientEffect — diagonal (theme default)">
          <GradientEffect direction="diagonal" style={styles.gradientPreview}>
            <View style={styles.gradientInner}>
              <Typography variant="bodySm_regular" style={styles.gradientLabel}>
                diagonal
              </Typography>
            </View>
          </GradientEffect>
        </ShowcaseItem>
        <ShowcaseItem label="GradientEffect — vertical">
          <GradientEffect direction="vertical" style={styles.gradientPreview}>
            <View style={styles.gradientInner}>
              <Typography variant="bodySm_regular" style={styles.gradientLabel}>
                vertical
              </Typography>
            </View>
          </GradientEffect>
        </ShowcaseItem>
        <ShowcaseItem label="GradientEffect — horizontal">
          <GradientEffect direction="horizontal" style={styles.gradientPreview}>
            <View style={styles.gradientInner}>
              <Typography variant="bodySm_regular" style={styles.gradientLabel}>
                horizontal
              </Typography>
            </View>
          </GradientEffect>
        </ShowcaseItem>
        <ShowcaseItem label="MinimalLine — default (muted)">
          <View style={styles.lineContainer}>
            <MinimalLine />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="MinimalLine — accent (brand gradient)">
          <View style={styles.lineContainer}>
            <MinimalLine variant="accent" />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="MinimalLine — vertical variants">
          <View style={styles.verticalLineRow}>
            <View style={styles.verticalLineWrapper}>
              <MinimalLine orientation="vertical" />
            </View>
            <View style={styles.verticalLineWrapper}>
              <MinimalLine orientation="vertical" variant="accent" />
            </View>
          </View>
        </ShowcaseItem>
      </ShowcaseSection>
    </ScrollView>
  )
}

const styles = StyleSheet.create(({spacing, colors}) => ({
  container: {
    flex: 1,
  },
  logoContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.spacing16,
    flexWrap: 'wrap',
  },
  content: {
    paddingVertical: spacing.spacing16,
    gap: spacing.spacing24,
  },
  typographyContainer: {
    gap: spacing.spacing8,
  },
  accordionContainer: {
    width: '100%',
    gap: spacing.spacing8,
  },
  qrContainer: {
    alignItems: 'center',
  },
  qrRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.spacing12,
  },
  addressContainer: {
    gap: spacing.spacing8,
  },
  imageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.spacing12,
  },
  logoPreview: {
    padding: spacing.spacing16,
    borderRadius: 12,
    alignItems: 'center',
  },
  logoDark: {
    backgroundColor: '#000',
  },
  logoLight: {
    backgroundColor: '#fff',
  },
  // Patterns & Effects styles
  gradientPreview: {
    width: '100%',
    height: 80,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#0A0A14',
  },
  gradientInner: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gradientLabel: {
    color: colors.textDefault,
    opacity: 0.7,
  },
  lineContainer: {
    width: '100%',
    paddingVertical: spacing.spacing8,
  },
  verticalLineRow: {
    flexDirection: 'row',
    gap: spacing.spacing24,
    height: 48,
    alignItems: 'center',
    paddingHorizontal: spacing.spacing8,
  },
  verticalLineWrapper: {
    height: '100%',
  },
}))
