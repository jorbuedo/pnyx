import {Stack} from 'expo-router'
import {useI18n} from '../../../src/providers'
import {AmountsHubScreen, useSendFlow} from '../../../src/screens/cardano/send'
import {MidnightAmountScreen} from '../../../src/screens/midnight/send/MidnightAmountScreen'

/**
 * One step, two rails. The rail came from the recipient the previous step resolved, so nothing is
 * chosen here — Cardano gets its basket hub, Midnight a single amount.
 *
 * The title is set here rather than in the group's `_layout`, which can only name one of them:
 * "Choose assets" over a screen with exactly one amount and no picker is a promise of a control that
 * is not there.
 */
export default function SendAmountsStep() {
  const {t} = useI18n()
  const {state} = useSendFlow()
  const midnight = state.rail.chain === 'midnight'
  return (
    <>
      <Stack.Screen
        options={{title: midnight ? t('midnightSend.stepAmountTitle') : t('cardanoSend.stepAmountsTitle')}}
      />
      {midnight ? <MidnightAmountScreen /> : <AmountsHubScreen />}
    </>
  )
}
