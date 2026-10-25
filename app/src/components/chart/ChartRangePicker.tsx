/**
 * Time-range selector for a value/price chart — the shared {@link SegmentedControl}
 * driven by the {@link ChartRange} vocabulary with localized labels. One canonical
 * picker; every chart surface uses it.
 *
 * @module
 */

import {useI18n} from '../../providers'
import type {ChartRange} from '../../services/price-history/range'
import {CHART_RANGES} from '../../services/price-history/range'
import {SegmentedControl} from '../SegmentedControl'

const LABEL_KEY = {
  '1D': 'chart.range1D',
  '1W': 'chart.range1W',
  '1M': 'chart.range1M',
  '6M': 'chart.range6M',
  '1Y': 'chart.range1Y',
  ALL: 'chart.rangeALL',
} as const satisfies Record<ChartRange, string>

export type ChartRangePickerProps = {
  readonly value: ChartRange
  readonly onChange: (range: ChartRange) => void
  readonly testID?: string
}

export const ChartRangePicker = ({value, onChange, testID}: ChartRangePickerProps) => {
  const {t} = useI18n()
  return (
    <SegmentedControl
      options={CHART_RANGES.map((r) => ({label: t(LABEL_KEY[r]), value: r}))}
      value={value}
      onChange={onChange}
      testID={testID}
    />
  )
}
