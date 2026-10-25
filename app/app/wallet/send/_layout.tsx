import {Stack} from 'expo-router'
import {ThemedStack} from '../../../src/components/ThemedStack'
import {useI18n} from '../../../src/providers'
import {SendFlowProvider} from '../../../src/screens/cardano/send'

export default function SendLayout() {
  const {t} = useI18n()

  return (
    <SendFlowProvider>
      <ThemedStack>
        <Stack.Screen name="index" options={{title: t('cardanoSend.title')}} />
        <Stack.Screen name="amounts" options={{title: t('cardanoSend.stepAmountsTitle')}} />
        <Stack.Screen name="edit-amount" options={{title: t('cardanoSend.stepEditAmountTitle')}} />
        <Stack.Screen name="allocate" options={{title: t('cardanoSend.stepAllocateTitle')}} />
      </ThemedStack>
    </SendFlowProvider>
  )
}
