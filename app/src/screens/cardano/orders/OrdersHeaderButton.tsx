/**
 * The Orders entry point, as a header action on the Swap screen.
 *
 * Carries an attention dot whenever the wallet has an open order, mirroring the
 * notification bell: an order resting on chain is something the user has to come
 * back to (it can fill, or need cancelling), so it needs to be visible from the
 * screen where they placed it rather than only from a list they have to know
 * about.
 *
 * The dot is a plain marker, not a count — how many is what the Orders list is
 * for, and a number here would compete with the bell for the same meaning.
 *
 * @module
 */

import {router} from 'expo-router'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {ButtonIcon} from '../../../components/Buttons'
import {useSwapOrders} from '../../../hooks/useSwapOrders'
import {useI18n} from '../../../providers'
import {filterOrders} from '../../../services/cardano-swap/order-model'

export const OrdersHeaderButton = () => {
  const {t} = useI18n()
  const {orders} = useSwapOrders()
  const hasOpen = filterOrders(orders, 'open', 'both').length > 0

  return (
    <View>
      <ButtonIcon
        icon="clock"
        variant="naked"
        size="md"
        onPress={() => router.push('/wallet/orders' as never)}
        containerProps={{accessibilityLabel: t('swapOrders.title')}}
        testID="swap-orders-link"
      />
      {hasOpen && <View style={styles.dot} testID="swap-orders-open-dot" />}
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  dot: {
    position: 'absolute',
    top: -1,
    right: -1,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.errorDefault,
  },
}))
