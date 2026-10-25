/**
 * Accepting an invitation to message someone.
 *
 * ⚠️ **A link never grants itself.** The permit arrives through the link-action sheet, which asks;
 * this screen is where it is actually taken up, and the only thing "accepting" does is file the
 * permit under the identity that issued it so a later message presents it. Nothing is sent, and no
 * conversation exists until the user starts one.
 *
 * ⚠️ **Nobody is named here.** The issuer is read out of the token, unverified — the content service
 * is what validates a permit — so this screen says what an invite *is* and shows the ID it will let
 * you write to, rather than asserting whose it is.
 *
 * @module
 */

import {Effect} from 'effect'
import {router, useLocalSearchParams} from 'expo-router'
import {useCallback, useMemo, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../src/components/Buttons'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../src/components/Typography'
import {useToast} from '../../src/hooks/useToast'
import {logger} from '../../src/logger'
import {useI18n, usePnyxSession} from '../../src/providers'
import {capturePermit} from '../../src/services/dm-consent'
import {permitIssuer} from '../../src/services/dm-permit-issuer'
import {deriveDmStoreKey} from '../../src/services/dm-session'

const ORIGIN = 'DmAcceptInviteScreen'

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect as Effect.Effect<A, never>)

export default function DmAcceptInviteScreen() {
  const {t} = useI18n()
  const {showToast} = useToast()
  const {session} = usePnyxSession()
  const {permit} = useLocalSearchParams<{permit?: string}>()
  const [saving, setSaving] = useState(false)

  const issuer = useMemo(() => (permit === undefined ? undefined : permitIssuer(permit)), [permit])

  const accept = useCallback(async () => {
    if (permit === undefined || issuer === undefined || session?.forumRoot === undefined) return
    setSaving(true)
    try {
      const storeKey = await run(deriveDmStoreKey(session.forumRoot))
      await run(capturePermit(storeKey, issuer, permit))
      logger.info('accepted a message invitation', {origin: ORIGIN})
      showToast({variant: 'success', message: t('forum.dm.invite.accepted')})
      // Straight to composing: the invitation's whole purpose is the conversation behind it.
      router.replace({pathname: '/dm/new', params: {peer: issuer}})
    } catch (error) {
      logger.error('the invitation could not be accepted', {origin: ORIGIN, error})
      showToast({variant: 'error', message: t('forum.dm.invite.acceptFailed')})
    } finally {
      setSaving(false)
    }
  }, [permit, issuer, session, showToast, t])

  // An unreadable token is the honest failure to show: it is not an invitation this app can use, and
  // saying so is better than a screen offering a button that cannot work.
  const unusable = permit === undefined || issuer === undefined

  return (
    <SafeAreaViewWrapper style={styles.safeArea} edges={['bottom']} scrollable contentContainerStyle={styles.content}>
      <Typography variant="headingSm">{t('forum.dm.invite.title')}</Typography>
      <Typography variant="bodySm_regular" style={styles.body}>
        {unusable ? t('forum.dm.invite.unusable') : t('forum.dm.invite.body')}
      </Typography>
      {!unusable && (
        <View style={styles.idBlock}>
          <Typography variant="bodyXs_regular" style={styles.label}>
            {t('forum.dm.invite.fromLabel')}
          </Typography>
          <Typography variant="bodyXs_regular" style={styles.id} testID="dm-invite-issuer">
            {issuer}
          </Typography>
        </View>
      )}
      <Button
        label={t('forum.dm.invite.accept')}
        variant="primary"
        onPress={() => void accept()}
        isDisabled={unusable || saving || session?.forumRoot === undefined}
        testID="dm-invite-accept"
      />
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {flex: 1},
  content: {padding: theme.spacing.spacing16, gap: theme.spacing.spacing16},
  body: {color: theme.colors.textMuted},
  idBlock: {gap: theme.spacing.spacing4},
  label: {color: theme.colors.textMuted},
  id: {color: theme.colors.textDefault},
}))
