/**
 * System logs viewer screen.
 *
 * Thin wrapper that renders the `DevLogsView` body. The screen header
 * is provided by the settings stack layout.
 *
 * @module
 */

import {DevLogsView} from '../../../src/components/DevLogsView'
import {SafeAreaViewWrapper} from '../../../src/components/SafeAreaViewWrapper'

export default function LogsScreen() {
  return (
    <SafeAreaViewWrapper style={{flex: 1}} edges={['bottom']}>
      <DevLogsView />
    </SafeAreaViewWrapper>
  )
}
