import {Stack} from 'expo-router'
import {ThemedStack} from '../../src/components/ThemedStack'
import {useI18n} from '../../src/providers'
import {OrdersHeaderButton} from '../../src/screens/cardano/orders/OrdersHeaderButton'

export default function WalletLayout() {
  const {t} = useI18n()

  return (
    <ThemedStack>
      {/* The send funnel is its own nested stack (app/wallet/send/_layout.tsx). */}
      <Stack.Screen name="send" options={{headerShown: false}} />
      {/* The tx title is shown in the screen body; the header stays neutral. */}
      <Stack.Screen name="review-tx" options={{title: ''}} />
      <Stack.Screen name="pair-device" options={{title: t('hardware.connectTitle')}} />
      <Stack.Screen name="assets" options={{title: t('cardanoPortfolio.portfolioTitle')}} />
      <Stack.Screen name="token/[id]" options={{title: t('cardanoPortfolio.assetTitle')}} />
      <Stack.Screen name="receive" options={{title: t('receive.title')}} />
      <Stack.Screen name="midnight/review" options={{title: t('midnightReview.title')}} />
      <Stack.Screen name="midnight/fund" options={{title: t('midnightFund.title')}} />
      <Stack.Screen name="midnight/transaction" options={{title: t('midnightTxReview.title')}} />
      <Stack.Screen name="midnight/tx/[hash]" options={{title: t('midnightTx.hash')}} />
      <Stack.Screen name="swap" options={{title: t('swap.title'), headerRight: () => <OrdersHeaderButton />}} />
      <Stack.Screen name="orders" options={{title: t('swapOrders.title')}} />
      <Stack.Screen name="order" options={{title: t('swapOrders.title')}} />
      <Stack.Screen name="swap-review" options={{title: t('swap.title')}} />
      <Stack.Screen name="transactions" options={{title: t('cardanoActivity.title')}} />
      <Stack.Screen name="tx/[hash]" options={{title: t('cardanoActivity.detailTitle')}} />
      <Stack.Screen name="tx-metadata" options={{title: t('txReview.details.metadata')}} />
      <Stack.Screen name="create-multisig" options={{title: t('multisig.create.title')}} />
      <Stack.Screen name="cosigner-key" options={{title: t('multisig.share.title')}} />
      <Stack.Screen name="shared-wallet" options={{title: t('multisig.composition.title')}} />
      <Stack.Screen name="shared-wallets" options={{title: t('multisig.list.title')}} />
      <Stack.Screen name="cosign" options={{title: t('cosign.title')}} />
      <Stack.Screen name="air-gap-request" options={{title: t('airGap.sign.title')}} />
      <Stack.Screen name="air-gap-export" options={{title: t('airGap.export.title')}} />
      <Stack.Screen name="air-gap-message" options={{title: t('airGap.message.title')}} />
      <Stack.Screen name="pending" options={{title: t('pending.title')}} />
      <Stack.Screen name="stake" options={{title: t('cardanoStaking.title')}} />
      <Stack.Screen name="utxos" options={{title: t('cardanoUtxos.title')}} />
      <Stack.Screen name="dust" options={{title: t('midnightDust.title')}} />
      <Stack.Screen name="donate" options={{title: t('cardanoDonate.title')}} />
      <Stack.Screen name="contacts" options={{title: t('contacts.title')}} />
      <Stack.Screen name="claim" options={{title: t('claim.title')}} />
    </ThemedStack>
  )
}
