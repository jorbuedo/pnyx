/**
 * Charts Showcase.
 *
 * Series-driven surfaces. AssetPriceChart and PortfolioValueChart drive their
 * own data hooks, so they fetch live here rather than taking a fixture — the
 * ones below them take a series directly.
 *
 * @module
 */

import {useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet, useUnistyles} from 'react-native-unistyles'

import {ChartRangePicker} from '../../components/chart/ChartRangePicker'
import {ChartSkeleton} from '../../components/chart/ChartSkeleton'
import {AssetPriceChart, PortfolioValueChart} from '../../components/chart/PortfolioValueChart'
import {PriceChart} from '../../components/chart/PriceChart'
import {Sparkline} from '../../components/chart/Sparkline'
import {ValueChartCard} from '../../components/chart/ValueChartCard'
import type {ChartRange} from '../../services/price-history/range'
import {ShowcaseItem, ShowcaseSection} from '../components'
import {fakeChartState, fakeChartStateLoading, fakePriceSeries, fakeSparkSeries} from '../data'

export const ChartsShowcase = () => {
  const {theme} = useUnistyles()
  const [range, setRange] = useState<ChartRange>('1W')

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ShowcaseSection title="Range picker">
        <ShowcaseItem label="ChartRangePicker">
          <View style={styles.full}>
            <ChartRangePicker value={range} onChange={setRange} />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Primitives" description="Take a series directly.">
        <ShowcaseItem label="PriceChart">
          <View style={styles.full}>
            <PriceChart series={fakePriceSeries} color={theme.colors.successDefault} />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Sparkline" inline>
          <Sparkline series={fakeSparkSeries} />
          <Sparkline series={fakeSparkSeries} width={120} height={40} />
        </ShowcaseItem>
        <ShowcaseItem label="ChartSkeleton">
          <View style={styles.full}>
            <ChartSkeleton height={140} />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Card" description="ValueChartCard composes the picker, the head value and the chart.">
        <ShowcaseItem label="ValueChartCard — resolved">
          <View style={styles.full}>
            <ValueChartCard
              state={fakeChartState}
              range={range}
              onRangeChange={setRange}
              preset="fiatBalance"
              showHeadValue
            />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="ValueChartCard — loading">
          <View style={styles.full}>
            <ValueChartCard state={fakeChartStateLoading} range={range} onRangeChange={setRange} preset="fiatPrice" />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection
        title="Hook-driven"
        description="These two own their range state and call the Cardano history hooks, so what they show depends on live data and the selected wallet."
      >
        <ShowcaseItem label="PortfolioValueChart">
          <View style={styles.full}>
            <PortfolioValueChart />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="AssetPriceChart — ADA">
          <View style={styles.full}>
            <AssetPriceChart asset={{kind: 'ada'}} />
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
