/**
 * Community tab — Discord-shaped layout: community rail on the left, channel
 * panel for the selected community on the right. Community selection is state
 * (persisted in MMKV via {@link readRailSelection}), not a route param —
 * the `/community/[id]` deep link writes the selection and lands here.
 *
 * The identicon + notification bell live in the shared `AppTopBar` (the tab
 * navigator header); the bottom tab bar owns the bottom inset. This screen still
 * owns the onboarding redirect guard, the ToS re-accept modal, and Android
 * double-back-to-exit.
 *
 * @module
 */

import {useIsFocused} from '@react-navigation/native'
import {router, useFocusEffect, useLocalSearchParams} from 'expo-router'
import {useCallback, useEffect, useRef, useState} from 'react'
import {BackHandler, ToastAndroid, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {CreateCommunitySheet} from '../../components/forum/CreateCommunitySheet'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {TosUpdateModal} from '../../components/TosUpdateModal'
import {useFeatureFlag} from '../../hooks/useFeatureFlag'
import {useWelcomeModalGate} from '../../hooks/useWelcomeModalGate'
import {useLegalAgreement} from '../../legal'
import {logger} from '../../logger'
import {platformIsAndroid} from '../../platform'
import {useRequestSystemNotifications} from '../../platform/notification-tools'
import {useI18n, usePnyxSession, useWalletCore} from '../../providers'
import {readComposerDraft} from '../../services/composer-draft'
import {DmInboxPane} from '../dm/DmInboxPane'
import {ChannelPanel} from './ChannelPanel'
import {CommunityRail} from './CommunityRail'
import {DiscoverPanel} from './DiscoverPanel'
import {InfoPanel} from './InfoPanel'
import {type RailSelection, readRailSelection, selectedCircleId, writeRailSelection} from './rail-selection'
import {useCommunities} from './useCommunities'

/** Timeout in ms for the double-back-to-exit gesture */
const BACK_EXIT_TIMEOUT = 2000

export function HomeScreen() {
  const {t} = useI18n()
  const {accepted: legalAccepted, isLoading: isLegalLoading} = useLegalAgreement()
  const {modal: legalModal, dismiss: dismissLegalModal} = useWelcomeModalGate()
  const pushNotificationsEnabled = useFeatureFlag('pushNotifications')
  useRequestSystemNotifications({enabled: pushNotificationsEnabled})
  const {isLoading: isWalletLoading, isReady} = useWalletCore()
  const {session, identityEstablished} = usePnyxSession()

  const {circles, joinedIds, error, isLoading: isCommunitiesLoading, refresh} = useCommunities()
  // A message another surface handed over to be sent into a DM — a shared-wallet
  // invitation or a co-sign request, today. Its presence is also what selects the
  // DM pane: arriving with something to send and landing on a community list
  // would leave the user to find the inbox themselves. It is an id into the
  // composer-draft slot, not the body — the body can be a whole envelope.
  const {draft} = useLocalSearchParams<{draft?: string}>()
  const [selection, setSelection] = useState<RailSelection | undefined>(() =>
    typeof draft === 'string' && draft !== '' ? {kind: 'dm'} : readRailSelection(),
  )
  const [createVisible, setCreateVisible] = useState(false)

  // Onboarding is gated purely on the singleton identity, not on funds wallets:
  // an identity-only install (identity/wallet split — the common case now) is
  // fully onboarded with zero funds wallets and must stay here. Redirect only
  // once everything has loaded and no identity is established.
  // `identityEstablished === false` (not `!== true`) so we wait out the async
  // probe rather than redirecting while it's still `undefined`; the
  // `isReady && !isWalletLoading` barrier lets the async identity probe resolve
  // before we treat `identityEstablished` as absent.
  useEffect(() => {
    if (isReady && !isWalletLoading && legalAccepted && identityEstablished === false) {
      logger.info('No identity found, redirecting to onboarding', {origin: 'HomeScreen', type: 'navigation'})
      router.replace('/onboarding/new-or-return')
    }
  }, [isReady, isWalletLoading, legalAccepted, identityEstablished])

  // Deep links (`/community/[id]`) write the selection and land back here —
  // pick the persisted value up on every focus.
  //
  // **An unsent draft outranks the persisted selection.** Selecting the DM pane cannot live in the
  // initial state alone: this tab is normally already mounted when a draft arrives (from the browser's
  // share sheet, or a co-sign / invite screen), an initializer does not run again, and this very
  // effect would restore the last community over it — leaving the user on a channel list with the
  // message they came to send nowhere in sight. Gated on the draft still being *live* rather than on
  // the param, so once it has been sent and cleared the pane stops hijacking focus.
  useFocusEffect(
    useCallback(() => {
      if (readComposerDraft(draft) !== undefined) {
        setSelection({kind: 'dm'})
        return
      }
      const stored = readRailSelection()
      if (stored !== undefined) {
        setSelection(stored)
      }
    }, [draft]),
  )

  const isFocused = useIsFocused()
  const lastBackPress = useRef(0)
  const handleBackPress = useCallback(() => {
    if (!isFocused) return false
    const now = Date.now()
    if (now - lastBackPress.current < BACK_EXIT_TIMEOUT) {
      BackHandler.exitApp()
      return true
    }
    lastBackPress.current = now
    if (platformIsAndroid) {
      ToastAndroid.show(t('common.labels.pressBackToExit'), ToastAndroid.SHORT)
    }
    return true
  }, [isFocused, t])

  useEffect(() => {
    if (!platformIsAndroid) return
    const subscription = BackHandler.addEventListener('hardwareBackPress', handleBackPress)
    return () => subscription.remove()
  }, [handleBackPress])

  const select = useCallback((id: string) => {
    setSelection({kind: 'circle', id})
    writeRailSelection({kind: 'circle', id})
  }, [])

  const joined = (circles ?? []).filter((circle) => joinedIds.has(circle.id))
  // Not rendered in the rail any more — this is what the cold-start fallback reaches for when the
  // viewer has joined nothing yet.
  const unjoined = (circles ?? []).filter((circle) => !joinedIds.has(circle.id))
  // What discover lists. Gated circles are listed too: a circle with self-service requirements
  // admits anyone who meets one, so hiding it kept it from exactly the people it is meant to let in.
  const discoverable = unjoined
  const dmSelected = selection?.kind === 'dm'
  const infoSelected = selection?.kind === 'info'
  const selectInfo = useCallback(() => {
    setSelection({kind: 'info'})
    writeRailSelection({kind: 'info'})
  }, [])
  const discoverSelected = selection?.kind === 'discover'
  const selectDiscover = useCallback(() => {
    setSelection({kind: 'discover'})
    writeRailSelection({kind: 'discover'})
  }, [])
  const selectDirectMessages = useCallback(() => {
    setSelection({kind: 'dm'})
    writeRailSelection({kind: 'dm'})
  }, [])

  // Falling back to the first available community is what makes a cold start land on *something*.
  // It must not apply when a non-community pane is selected, or choosing one would bounce straight
  // back to a community.
  const selectedCircle =
    dmSelected || discoverSelected || infoSelected
      ? undefined
      : ((circles ?? []).find((circle) => circle.id === selectedCircleId(selection)) ??
        joined[0] ??
        unjoined[0] ??
        undefined)

  // Wait for the legal check; the no-identity redirect above hands off to
  // /onboarding — render nothing while it lands. Mirror the redirect condition
  // exactly (identity-only installs have zero funds wallets but stay here).
  if (isLegalLoading) return null
  if (isReady && !isWalletLoading && legalAccepted && identityEstablished === false) return null

  return (
    <SafeAreaViewWrapper style={styles.safeArea} edges={[]} noPadding hasBottomMenu>
      <View style={styles.zones}>
        <CommunityRail
          joined={joined}
          selectedUnjoined={
            selectedCircle !== undefined && !joinedIds.has(selectedCircle.id) ? selectedCircle : undefined
          }
          selectedId={selectedCircle?.id}
          onSelect={select}
          dmSelected={dmSelected}
          onPressDirectMessages={selectDirectMessages}
          discoverSelected={discoverSelected}
          onPressDiscover={selectDiscover}
          infoSelected={infoSelected}
          onPressInfo={selectInfo}
          canCreate={session !== undefined}
          onPressCreate={() => setCreateVisible(true)}
        />
        {dmSelected ? (
          <DmInboxPane />
        ) : infoSelected ? (
          <InfoPanel />
        ) : discoverSelected ? (
          <DiscoverPanel
            circles={discoverable}
            listError={error !== undefined}
            isLoading={isCommunitiesLoading}
            onRefresh={refresh}
            onSelect={select}
          />
        ) : (
          <ChannelPanel circle={selectedCircle} listError={error !== undefined} onMembershipChanged={refresh} />
        )}
      </View>
      <CreateCommunitySheet
        visible={createVisible}
        onClose={() => setCreateVisible(false)}
        onCreated={(circleId) => {
          setCreateVisible(false)
          select(circleId)
          refresh()
        }}
      />
      <TosUpdateModal visible={legalModal === 'tos-update'} onDismiss={dismissLegalModal} />
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create(() => ({
  safeArea: {
    flex: 1,
  },
  zones: {
    flex: 1,
    flexDirection: 'row',
  },
}))
