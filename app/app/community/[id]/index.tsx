/**
 * Community deep link — selection is home-screen state, not a route param, so
 * this route persists the target community id and lands on `/home`, which
 * shows that community's channel panel. Kept as a route so notifications and
 * push intents can keep targeting `/community/[id]`.
 */

import {router, Stack, useLocalSearchParams} from 'expo-router'
import {useEffect} from 'react'
import {writeRailSelection} from '../../../src/screens/home/rail-selection'

export default function CommunityDeepLink() {
  const {id} = useLocalSearchParams<{id: string}>()

  useEffect(() => {
    if (id !== undefined) {
      writeRailSelection({kind: 'circle', id})
    }
    router.replace('/community')
  }, [id])

  return <Stack.Screen options={{headerShown: false}} />
}
