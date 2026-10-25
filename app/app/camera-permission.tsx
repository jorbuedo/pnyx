/**
 * Camera Permission Screen.
 *
 * Opened as a tab when the extension side panel / popup needs camera
 * access for the QR scanner. Chrome suppresses the getUserMedia
 * permission prompt in side-panel and popup contexts, so this tab
 * provides a regular browsing context where the prompt can appear.
 * Once granted here, the permission persists for the extension origin
 * and the scanner picks it up via the PermissionStatus change event.
 *
 * @module
 */

import {useCallback, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../src/components/Buttons'
import {Typography} from '../src/components/Typography'
import {UniIcon} from '../src/components/UniIcon'
import {logger} from '../src/logger'
import {closePopup} from '../src/platform/extension/surfaces'
import {useI18n} from '../src/providers'

type Status = 'idle' | 'requesting' | 'granted' | 'denied' | 'unsupported'

const ORIGIN = 'CameraPermission'

export default function CameraPermissionScreen() {
  const {t} = useI18n()
  const [status, setStatus] = useState<Status>('idle')

  const handleRequest = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      logger.error('getUserMedia not available in permission tab', {origin: ORIGIN})
      setStatus('unsupported')
      return
    }
    setStatus('requesting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({video: true})
      // The stream itself is not needed — only the persisted permission.
      for (const track of stream.getTracks()) track.stop()
      logger.info('Camera permission granted via tab', {origin: ORIGIN})
      setStatus('granted')
      setTimeout(() => closePopup(), 1500)
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e))
      logger.warn('Camera permission request failed in tab', {origin: ORIGIN, errorName: error.name})
      if (error.name === 'NotFoundError') {
        setStatus('unsupported')
        return
      }
      setStatus('denied')
    }
  }, [])

  const description =
    status === 'granted'
      ? t('scan.cameraPermissionTab.granted')
      : status === 'denied'
        ? t('scan.cameraPermissionTab.denied')
        : status === 'unsupported'
          ? t('scan.cameraPermissionTab.unsupported')
          : t('scan.cameraPermissionTab.description')

  return (
    <View style={styles.container}>
      <View>
        <UniIcon name="qr" size="xl" uniProps={(theme) => ({color: theme.colors.primaryDefault})} />
      </View>

      <Typography variant="headingMd" style={styles.title}>
        {t('scan.cameraPermissionTab.title')}
      </Typography>

      <Typography variant="bodyMd_regular" style={styles.description}>
        {description}
      </Typography>

      <Button
        label={
          status === 'granted'
            ? t('scan.cameraPermissionTab.grantedButton')
            : status === 'denied'
              ? t('scan.cameraPermissionTab.retry')
              : t('scan.cameraPermissionTab.allowButton')
        }
        onPress={status === 'granted' ? () => closePopup() : handleRequest}
        isLoading={status === 'requesting'}
        isDisabled={status === 'unsupported'}
        fullWidth
        testID="camera-permission-button"
      />
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: theme.spacing.spacing24,
    backgroundColor: theme.colors.backgroundDefault,
    gap: theme.spacing.spacing16,
  },
  title: {
    textAlign: 'center',
  },
  description: {
    textAlign: 'center',
    color: theme.colors.textAlternative,
    lineHeight: 22,
  },
}))
