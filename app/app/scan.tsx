/**
 * QR Scanner screen.
 *
 * Root-level screen that receives a header with back button from the root Stack.
 * Uses CameraScanner to scan QR codes, then parses and routes the result.
 *
 * Two kinds of code arrive here:
 *
 * - **A single code** (an address, a link) — parsed and routed on the first read, as before.
 * - **A UR frame** (`ur:…`) — one frame of an animated, possibly multi-part sequence. Those
 *   accumulate in a scan session and route only once the whole message is reassembled. There is
 *   no separate air-gap scanner: this is the app's one camera surface, so a Keystone-style
 *   request is scanned the same way as anything else.
 *
 * @module
 */

import {isUrFrame} from '@pnyx/ur'
import {useRouter} from 'expo-router'
import {useCallback, useRef, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {brand} from '../src/brand'
import {CameraScanner} from '../src/components/CameraScanner'
import type {InterpolationValues, TranslationKey} from '../src/i18n/types'
import {logger} from '../src/logger'
import {useI18n} from '../src/providers/I18nProvider'
import {registerScannedUr} from '../src/screens/cardano/airgap/scanned-request-handoff'
import {ACCEPTED_UR_TYPES, routeForScannedUr} from '../src/services/keystone/scan-routing'
import {type UrScanState, urScanSession} from '../src/services/keystone/ur-scan-session'
import {handleQrAction} from '../src/utils/qr-actions'
import {parseQrContent} from '../src/utils/qr-parser'

export default function ScanScreen() {
  const router = useRouter()
  const {t} = useI18n()

  const session = useRef(urScanSession({acceptedTypes: ACCEPTED_UR_TYPES}))
  // The camera runs continuously so a multi-frame sequence can complete; the single-code path
  // keeps its own once-only latch, since `handleQrAction` may leave us on this screen.
  const routed = useRef(false)
  const [urState, setUrState] = useState<UrScanState | null>(null)

  const handleCancel = useCallback(() => {
    router.back()
  }, [router])

  const handleScan = useCallback(
    (data: string) => {
      if (isUrFrame(data)) {
        const state = session.current.accept(data)
        setUrState(state)
        if (state.kind !== 'complete' || routed.current) return
        logger.info('UR scan complete', {origin: 'ScanScreen', type: 'user', urType: state.ur.type})
        const route = routeForScannedUr(state.ur.type, registerScannedUr(state.ur))
        // The session only completes types it was told to accept, so this is unreachable — but a
        // null here means the two disagree, and latching `routed` first would strand the screen.
        if (route === null) return
        routed.current = true
        router.replace(route as never)
        return
      }

      if (routed.current) return
      routed.current = true
      logger.info('QR code scanned', {origin: 'ScanScreen', type: 'user', dataLength: data.length})
      const action = parseQrContent(data, brand.scheme)
      handleQrAction(action, router, t)
      // An unrecognised code leaves the user here, so let them try another. Re-opening the latch
      // does not re-alert on the same code still in shot: `continuous` mode drops a read that
      // repeats the one before it, so only a genuinely different code gets through.
      if (action.type === 'unknown') routed.current = false
    },
    [router, t],
  )

  const hint = urHint(urState, t)

  return (
    <View style={styles.container}>
      <CameraScanner continuous onScan={handleScan} onCancel={handleCancel} {...(hint === undefined ? {} : {hint})} />
    </View>
  )
}

type Translate = (key: TranslationKey, values?: InterpolationValues) => string

/** While a sequence is in flight the hint becomes its progress; otherwise the standing hint. */
const urHint = (state: UrScanState | null, t: Translate): string | undefined => {
  if (state === null) return undefined
  if (state.kind === 'scanning') return t('airGap.scan.progress', {percent: Math.round(state.progress.fraction * 100)})
  if (state.kind === 'error' && !state.recoverable) return t('airGap.scan.wedged')
  return undefined
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
}))
