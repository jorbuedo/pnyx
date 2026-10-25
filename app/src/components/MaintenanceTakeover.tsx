/**
 * Full-screen, non-dismissable maintenance takeover.
 *
 * Brand mark, title-led message, and a scam warning. Rendered over the whole
 * app when the remote-config `maintenance.app` flag is set, blocking all
 * activity until service resumes. No header, no back, no CTA.
 *
 * It names no support route on purpose: the takeover blocks the app, so in-app
 * support is exactly what cannot be reached from here.
 *
 * @module
 */

import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useRemoteConfig} from '../providers/ConfigProvider'
import {useI18n} from '../providers/I18nProvider'
import {ChamferBackground} from './Chamfer'
import {SafeAreaViewWrapper} from './SafeAreaViewWrapper'
import {Typography} from './Typography'
import {UniIcon} from './UniIcon'

/** Remote-config maintenance key that triggers the global takeover. */
const APP_MAINTENANCE_KEY = 'app'

/** True when the app-wide maintenance flag is set in remote config. */
export const useAppMaintenance = (): boolean => {
  const {maintenance} = useRemoteConfig()
  return maintenance?.[APP_MAINTENANCE_KEY] === true
}

export function MaintenanceTakeover() {
  const {t} = useI18n()
  return (
    <SafeAreaViewWrapper edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.screen}>
        <View style={styles.brand}>
          <UniIcon name="wallet" size="md" uniProps={(theme) => ({color: theme.colors.primaryDefault})} />
          <Typography variant="bodySm_regular" style={styles.brandLabel}>
            {t('maintenance.brand')}
          </Typography>
        </View>

        <View style={styles.content}>
          <Typography variant="headingLg" style={styles.title}>
            {t('maintenance.title')}
          </Typography>
          <Typography variant="bodyMd_regular" style={styles.body}>
            {t('maintenance.body')}
          </Typography>
          <View style={styles.points}>
            <View style={styles.point}>
              <ChamferBackground
                size="auto"
                fillToken="backgroundAlternative"
                borderToken="borderDefaultWeak"
                borderWidth={1}
              />
              <Typography variant="bodySm_regular" style={styles.pointText}>
                {t('maintenance.scamPoint')}
              </Typography>
            </View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  screen: {flexGrow: 1, paddingHorizontal: theme.spacing.spacing20, paddingBottom: theme.spacing.spacing24},
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.spacing8,
    paddingTop: theme.spacing.spacing20,
  },
  brandLabel: {color: theme.colors.textDefault},
  content: {marginTop: theme.spacing.spacing24},
  title: {color: theme.colors.textDefault, marginBottom: theme.spacing.spacing12},
  body: {color: theme.colors.textAlternative, marginBottom: theme.spacing.spacing20},
  points: {gap: theme.spacing.spacing12},
  point: {
    padding: theme.spacing.spacing16,
  },
  pointText: {color: theme.colors.textAlternative},
}))
