/**
 * Web-only camera QR code scanner using getUserMedia + jsQR.
 *
 * Renders a `<video>` element with camera feed and scans frames
 * for QR codes using a hidden `<canvas>`. Provides the same overlay
 * UI (dark mask, scan window, corner indicators) as the native CameraScanner.
 *
 * @module
 */

import jsQR from 'jsqr'
import {useCallback, useEffect, useRef, useState} from 'react'
import {TouchableOpacity, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {logger} from '../logger'
import {isExtension} from '../platform'
import {sendMessageFireAndForget} from '../platform/extension/runtime'
import {useI18n} from '../providers'

import {admitScan, initialScanGate, type ScanGate} from './camera-scan-gate'
import {Typography} from './Typography'

const SCAN_WINDOW_SIZE = 280
const CORNER_SIZE = 24
const CORNER_WIDTH = 4

type WebCameraScannerProps = {
  onScan: (data: string) => void
  onCancel?: () => void
  /** Keep delivering distinct frames instead of firing once — needed to read an animated QR. */
  continuous?: boolean
  /** Replaces the standing hint, for a caller with something better to say (e.g. scan progress). */
  hint?: string
}

/**
 * `blocked` = getUserMedia rejected in an extension surface where Chrome
 * suppresses the permission prompt (side panel / popup) — the
 * user must grant access from a regular tab instead.
 */
type PermissionState = 'pending' | 'granted' | 'denied' | 'blocked' | 'unsupported'

/** Current camera permission state for this origin, `null` when unqueryable. */
const queryCameraPermission = async (): Promise<globalThis.PermissionState | null> => {
  try {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return null
    // 'camera' is missing from lib.dom's PermissionName union but supported in Chrome.
    const status = await navigator.permissions.query({name: 'camera' as PermissionName})
    return status.state
  } catch (e: unknown) {
    // `null` is also "the Permissions API is absent", which is the branch above — so a query
    // that threw and a browser without the API are the same answer to the caller.
    logger.debug('Camera permission state could not be queried', {
      origin: 'WebCameraScanner',
      error: String(e),
    })
    return null
  }
}

/**
 * Web camera scanner with QR overlay using getUserMedia + jsQR.
 *
 * Features:
 * - Camera permission request and denied state handling
 * - Dark overlay mask with transparent scanning window
 * - Corner indicators on scanning window
 * - Fires once, or every distinct frame under `continuous` (see `camera-scan-gate`)
 * - Handles browsers without getUserMedia support
 */
export function WebCameraScanner({onScan, onCancel, continuous = false, hint}: WebCameraScannerProps) {
  const {t} = useI18n()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const animFrameRef = useRef<number>(0)
  const gateRef = useRef<ScanGate>(initialScanGate)
  const streamRef = useRef<MediaStream | null>(null)
  const startingRef = useRef(false)
  const [permissionState, setPermissionState] = useState<PermissionState>('pending')

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop()
      }
      streamRef.current = null
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current)
      animFrameRef.current = 0
    }
  }, [])

  const scanFrame = useCallback(() => {
    if (gateRef.current.latched) return

    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
      animFrameRef.current = requestAnimationFrame(scanFrame)
      return
    }

    const ctx = canvas.getContext('2d', {willReadFrequently: true})
    if (!ctx) {
      animFrameRef.current = requestAnimationFrame(scanFrame)
      return
    }

    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const code = jsQR(imageData.data, imageData.width, imageData.height, {inversionAttempts: 'dontInvert'})

    if (code?.data) {
      const {gate, deliver} = admitScan(gateRef.current, code.data, continuous)
      gateRef.current = gate
      if (deliver) onScan(code.data)
      if (gate.latched) return
    }

    animFrameRef.current = requestAnimationFrame(scanFrame)
  }, [onScan, continuous])

  const startCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setPermissionState('unsupported')
      return
    }
    // Single-flight: the mount effect, the permission listener's recovery,
    // and the denied-UI retry can overlap — two successful getUserMedia
    // calls would leak the first stream's tracks (camera stays on).
    if (startingRef.current || streamRef.current) return
    startingRef.current = true

    try {
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: 'environment'}})
      } catch (err) {
        // Some desktop webcams reject the facingMode hint outright — retry
        // without constraints before classifying the failure.
        const error = err as DOMException
        if (error.name !== 'OverconstrainedError' && error.name !== 'NotFoundError') throw err
        stream = await navigator.mediaDevices.getUserMedia({video: true})
      }
      streamRef.current = stream
      setPermissionState('granted')
    } catch (err) {
      const error = err as DOMException
      logger.warn('Web camera scanner getUserMedia failed', {origin: 'WebCameraScanner', errorName: error.name})
      if (error.name === 'NotFoundError') {
        setPermissionState('unsupported')
        return
      }
      if (error.name !== 'NotAllowedError' && error.name !== 'PermissionDeniedError') {
        // NotReadableError / AbortError / … — permission wasn't the problem
        // (camera busy or hardware hiccup); a retry can help, the grant tab
        // can't.
        setPermissionState('denied')
        return
      }
      if (!isExtension) {
        setPermissionState('denied')
        return
      }
      // Chrome suppresses the permission prompt in extension side panels /
      // popups: getUserMedia rejects with NotAllowedError while the origin's
      // permission is still "ask" — a retry can never succeed there and the
      // grant has to happen in a regular tab (camera-permission route). A
      // hard per-origin denial ('denied') keeps the denied UI instead: the
      // tab prompt won't render either, only browser settings can fix it.
      const state = await queryCameraPermission()
      // A concurrent startCamera (the permission listener's recovery) may
      // have succeeded while we awaited — never clobber a live stream's
      // 'granted' with a stale failure classification.
      if (streamRef.current) return
      setPermissionState(state === 'denied' ? 'denied' : 'blocked')
    } finally {
      startingRef.current = false
    }
  }, [])

  useEffect(() => {
    startCamera()
    return stopStream
  }, [startCamera, stopStream])

  // Recover automatically once the user grants access in the
  // camera-permission tab: the PermissionStatus change event fires in this
  // context too, so the scanner restarts without a manual retry. The
  // immediate onChange() call covers a grant that landed before the query
  // resolved (state already 'granted' with no stream).
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return
    let status: PermissionStatus | null = null
    let disposed = false
    const onChange = () => {
      if (status?.state === 'granted' && !streamRef.current) startCamera()
    }
    navigator.permissions
      // 'camera' is missing from lib.dom's PermissionName union but supported in Chrome.
      .query({name: 'camera' as PermissionName})
      .then((s) => {
        if (disposed) return
        status = s
        s.addEventListener('change', onChange)
        onChange()
      })
      .catch((e) => {
        logger.warn('Camera permission state unavailable; scanning starts blind', {
          origin: 'WebCameraScanner',
          error: String(e),
        })
      })
    return () => {
      disposed = true
      status?.removeEventListener('change', onChange)
    }
  }, [startCamera])

  const openPermissionTab = useCallback(() => {
    sendMessageFireAndForget({type: 'OPEN_CAMERA_PERMISSION_TAB'})
  }, [])

  // Attach stream to video element once permission is granted and element is rendered
  useEffect(() => {
    if (permissionState !== 'granted' || !streamRef.current || !videoRef.current) return
    videoRef.current.srcObject = streamRef.current
    videoRef.current.play().catch((e) => {
      logger.warn('Camera preview did not start playing', {origin: 'WebCameraScanner', error: String(e)})
    })
    animFrameRef.current = requestAnimationFrame(scanFrame)
  }, [permissionState, scanFrame])

  if (permissionState === 'unsupported') {
    return (
      <View style={styles.centered}>
        <Typography variant="bodyMd_regular" style={styles.permissionText}>
          {t('scan.webNotSupported')}
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

  if (permissionState === 'blocked') {
    return (
      <View style={styles.centered}>
        <Typography variant="headingSm" style={styles.permissionTitle}>
          {t('scan.permissionTitle')}
        </Typography>
        <Typography variant="bodyMd_regular" style={styles.permissionText}>
          {t('scan.extensionPermissionBlocked')}
        </Typography>
        <TouchableOpacity
          style={styles.permissionButton}
          onPress={openPermissionTab}
          testID="scanner-grant-camera-button"
        >
          <Typography variant="bodyMd_medium" style={styles.permissionButtonText}>
            {t('scan.extensionPermissionButton')}
          </Typography>
        </TouchableOpacity>

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

  if (permissionState === 'denied') {
    return (
      <View style={styles.centered}>
        <Typography variant="headingSm" style={styles.permissionTitle}>
          {t('scan.permissionTitle')}
        </Typography>
        <Typography variant="bodyMd_regular" style={styles.permissionText}>
          {t('scan.webPermissionDenied')}
        </Typography>
        <TouchableOpacity style={styles.permissionButton} onPress={startCamera}>
          <Typography variant="bodyMd_medium" style={styles.permissionButtonText}>
            {t('scan.permissionButton')}
          </Typography>
        </TouchableOpacity>

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

  if (permissionState === 'pending') {
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

  return (
    <View style={styles.container}>
      {/* Video element - rendered via dangerouslySetInnerHTML to avoid RNW View wrapping */}
      <View style={styles.videoContainer}>
        <video
          ref={videoRef as React.RefObject<HTMLVideoElement>}
          style={{width: '100%', height: '100%', objectFit: 'cover'}}
          playsInline
          muted
          autoPlay
        />
      </View>

      {/* Hidden canvas for frame analysis */}
      <canvas ref={canvasRef as React.RefObject<HTMLCanvasElement>} style={{display: 'none'}} />

      {/* Overlay mask */}
      <View style={[styles.overlay, {pointerEvents: 'box-none'}]}>
        {/* Top mask */}
        <View style={styles.maskTop} />

        {/* Middle row: left mask + scan window + right mask */}
        <View style={styles.middleRow}>
          <View style={styles.maskSide} />

          {/* Scan window with corner indicators */}
          <View style={styles.scanWindow}>
            <View style={[styles.corner, styles.cornerTopLeft]} />
            <View style={[styles.corner, styles.cornerTopRight]} />
            <View style={[styles.corner, styles.cornerBottomLeft]} />
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
    position: 'relative',
  },
  videoContainer: {
    flex: 1,
    overflow: 'hidden',
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
