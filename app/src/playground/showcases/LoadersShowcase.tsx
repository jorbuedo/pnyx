/**
 * Loaders Showcase.
 *
 * Demonstrates loading indicators and skeleton placeholders.
 *
 * @module
 */

import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {ClockLogomark} from '../../components/illustrations'
import {CircleLoader, Skeleton, SkeletonSquare} from '../../components/Loaders'
import {Typography} from '../../components/Typography'
import {ShowcaseItem, ShowcaseSection} from '../components'

export const LoadersShowcase = () => {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ShowcaseSection
        title="Logomark"
        description="The mark as a clock: a second per quarter turn, resting alternately on the Pnyx mark and Midnight's"
      >
        <ShowcaseItem label="Sizes">
          <ClockLogomark width={40} cycles={-1} />
          <ClockLogomark width={72} cycles={-1} />
          <ClockLogomark width={120} cycles={-1} />
        </ShowcaseItem>
        <ShowcaseItem label="Half speed">
          <ClockLogomark width={120} speed={2} cycles={-1} />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Circle Loader" description="Spinning loading indicator">
        <ShowcaseItem label="Sizes">
          <CircleLoader size="sm" />
          <CircleLoader size="md" />
          <CircleLoader size="lg" />
        </ShowcaseItem>
        <ShowcaseItem label="Custom Color">
          <CircleLoader size="md" color="#6C5CE7" />
          <CircleLoader size="md" color="#10B981" />
          <CircleLoader size="md" color="#F59E0B" />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Skeleton" description="Text placeholder with shimmer animation">
        <ShowcaseItem label="Loading State">
          <View style={styles.skeletonContainer}>
            <Skeleton show width={200} height={20}>
              <Typography variant="bodyMd_regular">Content loaded</Typography>
            </Skeleton>
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Different Sizes">
          <View style={styles.skeletonContainer}>
            <Skeleton show width={100} height={16}>
              {null}
            </Skeleton>
            <Skeleton show width={180} height={16}>
              {null}
            </Skeleton>
            <Skeleton show width={140} height={16}>
              {null}
            </Skeleton>
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Shapes">
          <Skeleton show width={48} height={48} shape="circle">
            {null}
          </Skeleton>
          <Skeleton show width={48} height={48} shape="round">
            {null}
          </Skeleton>
          <Skeleton show width={48} height={48} shape="square">
            {null}
          </Skeleton>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Skeleton Square" description="Square/rectangular placeholder">
        <ShowcaseItem label="Sizes">
          <SkeletonSquare show size={24}>
            {null}
          </SkeletonSquare>
          <SkeletonSquare show size={40}>
            {null}
          </SkeletonSquare>
          <SkeletonSquare show size={56}>
            {null}
          </SkeletonSquare>
        </ShowcaseItem>
        <ShowcaseItem label="Shapes">
          <SkeletonSquare show size={48} shape="circle">
            {null}
          </SkeletonSquare>
          <SkeletonSquare show size={48} shape="square">
            {null}
          </SkeletonSquare>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Loading Card Example" description="Combining skeleton components">
        <View style={styles.loadingCard}>
          <View style={styles.loadingCardHeader}>
            <SkeletonSquare show size={48} shape="circle">
              {null}
            </SkeletonSquare>
            <View style={styles.loadingCardText}>
              <Skeleton show width={120} height={16}>
                {null}
              </Skeleton>
              <Skeleton show width={80} height={14}>
                {null}
              </Skeleton>
            </View>
          </View>
          <View style={styles.loadingCardBody}>
            <Skeleton show width={280} height={14}>
              {null}
            </Skeleton>
            <Skeleton show width={280} height={14}>
              {null}
            </Skeleton>
            <Skeleton show width={160} height={14}>
              {null}
            </Skeleton>
          </View>
        </View>
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
  skeletonContainer: {
    width: '100%',
    gap: spacing.spacing8,
  },
  loadingCard: {
    backgroundColor: colors.backgroundAlternative,
    borderRadius: borderRadius.rounded12,
    padding: spacing.spacing16,
    gap: spacing.spacing16,
  },
  loadingCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.spacing12,
  },
  loadingCardText: {
    gap: spacing.spacing8,
  },
  loadingCardBody: {
    gap: spacing.spacing8,
  },
}))
