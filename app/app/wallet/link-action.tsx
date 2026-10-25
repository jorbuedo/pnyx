/**
 * The entry point a *scanned* link action lands on.
 *
 * All the substance is in {@link LinkActionSheet}, which a card in a DM or a circle
 * opens inline. A scan or a deep link has no card to tap, so this route exists to
 * give it the same sheet — one component, two entry points, rather than a screen and
 * a sheet drifting apart over the same two questions.
 *
 * Closing it goes back rather than dismissing to nothing: arriving here from a scan
 * means there is no screen underneath.
 *
 * @module
 */

import {router, Stack, useLocalSearchParams} from 'expo-router'
import {useCallback, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {LinkActionSheet, type LinkActionSubject} from '../../src/screens/cardano/LinkActionSheet'
import {claimLinkActionSubject} from '../../src/screens/cardano/link-action-handoff'

export default function LinkActionScreen() {
  const {subject: subjectParam} = useLocalSearchParams<{subject?: string}>()

  /**
   * Claimed once and held. The registry evicts on claim so a re-mount cannot
   * re-apply a stale link, but this screen re-renders as the sheet's selections
   * change, so the value has to survive that.
   */
  const [subject] = useState<LinkActionSubject | null>(() =>
    typeof subjectParam === 'string' && subjectParam !== '' ? (claimLinkActionSubject(subjectParam) ?? null) : null,
  )

  const close = useCallback(() => {
    if (router.canGoBack()) router.back()
    else router.replace('/wallets')
  }, [])

  return (
    <SafeAreaViewWrapper style={styles.safeArea} edges={['top', 'bottom']} noPadding>
      <Stack.Screen options={{headerShown: false}} />
      <View style={styles.backdrop} />
      <LinkActionSheet visible onClose={close} subject={subject} />
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {flex: 1},
  backdrop: {flex: 1, backgroundColor: theme.colors.background},
}))
