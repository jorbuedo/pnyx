import {Image} from 'expo-image'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useI18n} from '../providers'
import {CircleLoader} from './Loaders'
import {Typography} from './Typography'

const logoSource = require('../../assets/logo.png')

export const UpdateOverlay = () => {
  const {t} = useI18n()

  return (
    <View style={styles.container} testID="update-overlay">
      <Image source={logoSource} style={styles.logo} contentFit="contain" />
      <Typography variant="headingMd" style={styles.title}>
        {t('common.update.title')}
      </Typography>
      <Typography variant="bodyMd_regular" style={styles.subtitle}>
        {t('common.update.subtitle')}
      </Typography>
      <CircleLoader size="lg" />
    </View>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.backgroundDefault,
    paddingHorizontal: spacing.spacing24,
    gap: spacing.spacing16,
  },
  logo: {
    width: 96,
    height: 96,
  },
  title: {
    color: colors.textDefault,
    textAlign: 'center',
  },
  subtitle: {
    color: colors.textAlternative,
    textAlign: 'center',
    maxWidth: 320,
  },
}))
