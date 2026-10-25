/**
 * Camera QR code scanner component.
 *
 * Provides a camera view with QR scanning overlay, permission handling,
 * and web platform fallback.
 *
 * @module
 */

import {CameraView, useCameraPermissions} from 'expo-camera'
import {useCallback, useRef, useState} from 'react'
import {Linking, TouchableOpacity, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {useI18n} from '../providers'

import {admitScan, initialScanGate, type ScanGate} from './camera-scan-gate'
import {Typography} from './Typography'

const SCAN_WINDOW_SIZE = 280
const CORNER_SIZE = 24
const CORNER_WIDTH = 4

type CameraScannerProps = {
  onScan: (data: string) => void
  onCancel?: () => void
  /** Keep delivering distinct frames instead of firing once — needed to read an animated QR. */
  continuous?: boolean
  /** Replaces the standing hint, for a caller with something better to say (e.g. scan progress). */
  hint?: string
}

/**
 * Reusable camera scanner with QR overlay.
 *
 * Features:
 * - Camera permission request and denied state handling
 * - Dark overlay mask with transparent scanning window
 * - Corner indicators on scanning window
 * - Fires once, or every distinct frame under `continuous` (see `camera-scan-gate`)
 * - Web platform fallback message
 */
export function CameraScanner({onScan, onCancel, continuous = false, hint}: CameraScannerProps) {
  const {t} = useI18n()
  const [permission, requestPermission] = useCameraPermissions()
  const gateRef = useRef<ScanGate>(initialScanGate)
  // Detaching the handler is what actually stops expo-camera decoding frames, so the latch
  // needs to reach render — the ref alone would leave the sensor working after a single shot.
  const [stopped, setStopped] = useState(false)

  const handleBarcodeScanned = useCallback(
    ({data}: {data: string}) => {
      const {gate, deliver} = admitScan(gateRef.current, data, continuous)
      gateRef.current = gate
      if (gate.latched) setStopped(true)
      if (deliver) onScan(data)
    },
    [onScan, continuous],
  )

  // Permission not yet determined
  if (!permission) {
    return (
      <View style={styles.centered}>
        <Typography variant="bodyMd_regular" style={styles.permissionText}>
          {t('scan.permissionMessage')}
        </Typography>

        {onCancel != null && (
          <TouchableOpacity style={styles.cancelButtonLight} onPress={onCancel}>
            <Typography variant="bodyMd_medium" style={styles.cancelButtonLightText}>
              {t('scan.cancel')}
            </Typography>
          </TouchableOpacity>
        )}
      </View>
    )
  }

  // Permission denied
  if (!permission.granted) {
    return (
      <View style={styles.centered}>
        <Typography variant="headingSm" style={styles.permissionTitle}>
          {t('scan.permissionTitle')}
        </Typography>
        <Typography variant="bodyMd_regular" style={styles.permissionText}>
          {t('scan.permissionMessage')}
        </Typography>

        {permission.canAskAgain ? (
          <TouchableOpacity style={styles.permissionButton} onPress={requestPermission}>
            <Typography variant="bodyMd_medium" style={styles.permissionButtonText}>
              {t('scan.permissionButton')}
            </Typography>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.permissionButton} onPress={() => Linking.openSettings()}>
            <Typography variant="bodyMd_medium" style={styles.permissionButtonText}>
              {t('scan.permissionButton')}
            </Typography>
          </TouchableOpacity>
        )}

        {onCancel != null && (
          <TouchableOpacity style={styles.cancelButtonLight} onPress={onCancel}>
            <Typography variant="bodyMd_medium" style={styles.cancelButtonLightText}>
              {t('scan.cancel')}
            </Typography>
          </TouchableOpacity>
        )}
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={styles.camera}
        facing="back"
        barcodeScannerSettings={{barcodeTypes: ['qr']}}
        onBarcodeScanned={stopped ? undefined : handleBarcodeScanned}
      />

      {/* Overlay mask */}
      <View style={[styles.overlay, {pointerEvents: 'box-none'}]}>
        {/* Top mask */}
        <View style={styles.maskTop} />

        {/* Middle row: left mask + scan window + right mask */}
        <View style={styles.middleRow}>
          <View style={styles.maskSide} />

          {/* Scan window with corner indicators */}
          <View style={styles.scanWindow}>
            {/* Top-left corner */}
            <View style={[styles.corner, styles.cornerTopLeft]} />
            {/* Top-right corner */}
            <View style={[styles.corner, styles.cornerTopRight]} />
            {/* Bottom-left corner */}
            <View style={[styles.corner, styles.cornerBottomLeft]} />
            {/* Bottom-right corner */}
            <View style={[styles.corner, styles.cornerBottomRight]} />
          </View>

          <View style={styles.maskSide} />
        </View>

        {/* Bottom mask with hint text and cancel button */}
        <View style={styles.maskBottom}>
          <Typography variant="bodyMd_regular" style={styles.hintText}>
            {hint ?? t('scan.hint')}
          </Typography>

          {onCancel != null && (
            <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
              <Typography variant="bodyMd_medium" style={styles.cancelButtonText}>
                {t('scan.cancel')}
              </Typography>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  camera: {
    flex: 1,
  },
  centered: {
    flex: 1,
    backgroundColor: theme.colors.backgroundDefault,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.spacing24,
    gap: theme.spacing.spacing16,
  },
  permissionTitle: {
    color: theme.colors.textDefault,
    textAlign: 'center',
  },
  permissionText: {
    color: theme.colors.textAlternative,
    textAlign: 'center',
    lineHeight: 24,
  },
  permissionButton: {
    backgroundColor: theme.colors.primaryDefault,
    paddingHorizontal: theme.spacing.spacing24,
    paddingVertical: theme.spacing.spacing12,
    borderRadius: theme.borderRadius.rounded12,
  },
  permissionButtonText: {
    color: theme.colors.primaryInverse,
  },
  overlay: {
    ...({position: 'absolute', top: 0, left: 0, right: 0, bottom: 0} as const),
  },
  maskTop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  middleRow: {
    flexDirection: 'row',
    height: SCAN_WINDOW_SIZE,
  },
  maskSide: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  scanWindow: {
    width: SCAN_WINDOW_SIZE,
    height: SCAN_WINDOW_SIZE,
    borderRadius: theme.borderRadius.rounded12,
  },
  maskBottom: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    paddingTop: theme.spacing.spacing24,
  },
  hintText: {
    color: 'white',
    textAlign: 'center',
  },
  cancelButton: {
    marginTop: theme.spacing.spacing24,
    paddingHorizontal: theme.spacing.spacing32,
    paddingVertical: theme.spacing.spacing12,
    borderRadius: theme.borderRadius.rounded12,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  cancelButtonText: {
    color: 'white',
    textAlign: 'center',
  },
  cancelButtonLight: {
    paddingHorizontal: theme.spacing.spacing32,
    paddingVertical: theme.spacing.spacing12,
    borderRadius: theme.borderRadius.rounded12,
  },
  cancelButtonLightText: {
    color: theme.colors.textAlternative,
    textAlign: 'center',
  },
  corner: {
    position: 'absolute',
    width: CORNER_SIZE,
    height: CORNER_SIZE,
  },
  cornerTopLeft: {
    top: 0,
    left: 0,
    borderTopWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
    borderColor: 'white',
    borderTopLeftRadius: theme.borderRadius.rounded12,
  },
  cornerTopRight: {
    top: 0,
    right: 0,
    borderTopWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
    borderColor: 'white',
    borderTopRightRadius: theme.borderRadius.rounded12,
  },
  cornerBottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
    borderColor: 'white',
    borderBottomLeftRadius: theme.borderRadius.rounded12,
  },
  cornerBottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
    borderColor: 'white',
    borderBottomRightRadius: theme.borderRadius.rounded12,
  },
}))
