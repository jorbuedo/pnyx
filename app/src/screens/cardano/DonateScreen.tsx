/**
 * Donate — placeholder. The planned flow lets the user split a single donation
 * across several recipients (our address, Koios, the Cardano treasury) with a
 * slider per recipient. Stubbed until that's built; shows the intent rather
 * than a non-functional form.
 *
 * @module
 */

import {StyleSheet} from 'react-native-unistyles'
import {EmptyState} from '../../components/EmptyState'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {useI18n} from '../../providers'

export const DonateScreen = () => {
  const {t} = useI18n()
  return (
    <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.center}>
      <EmptyState
        icon="support"
        title={t('cardanoDonate.comingSoonTitle')}
        description={t('cardanoDonate.comingSoonBody')}
      />
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create(({spacing}) => ({
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.spacing24},
}))
