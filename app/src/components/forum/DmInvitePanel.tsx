/**
 * Making an invitation to message you: a link, a QR of the same link, and a way to withdraw it.
 *
 * ⚠️ **An invite names nobody, and that is what makes it shareable.** Whoever opens it converts it
 * into a permit of their own, so it works as a QR held up to a room or a link posted in a circle —
 * which a targeted permit cannot, since that would need the other person's ID first
 * (`docs/ABUSE_MITIGATION.md` §5). The copy has to be honest about the consequence: anyone who sees
 * it can use it.
 *
 * ⚠️ **Revoking is not un-inviting.** It stops *new* people using the link; anyone who already
 * converted keeps their conversation, because their permit carries its own id. The hint says so —
 * this is the part that surprises people, and finding out by being messaged is a bad way to learn.
 *
 * ⚠️ **What is issued is remembered on this device, because nowhere else can.** Issuing a permit
 * writes nothing on the service, so an invitation held only in component state was withdrawable
 * exactly until the screen closed — and its default life is 180 days. The list comes from the
 * permit book ({@link module:../../services/dm-permit-book}); losing it is the failure this panel
 * is shaped to avoid, which is why an unreadable book says so instead of showing an empty list.
 *
 * @module
 */

import {buildBrandLink} from '@pnyx/links'
import {Effect} from 'effect'
import {useCallback, useEffect, useState} from 'react'
import {Share, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useFormatDate} from '../../hooks/useFormatDate'
import {logger} from '../../logger'
import {useI18n} from '../../providers'
import {type DmPolicyChoice, dmApi} from '../../services/dm-api'
import {listIssuedInvites, rememberInvite, revokeIssuedInvite} from '../../services/dm-consent'
import type {DmIssuedInvite} from '../../services/dm-permit-book'
import {type DmStoreKey, deriveDmStoreKey} from '../../services/dm-session'
import {Accordion} from '../Accordion'
import {Button} from '../Buttons'
import {QRCard} from '../QRCard'
import {Typography} from '../Typography'

const ORIGIN = 'DmInvitePanel'

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect as Effect.Effect<A, never>)

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

export type DmInvitePanelProps = {
  /** The session token, or `undefined` when signed out — the panel then offers nothing. */
  readonly token: string | undefined
  /**
   * Seals the permit book. Absent on a session with no seed (the manual-card path), which is also a
   * session that cannot keep what it issues — so the panel offers nothing rather than minting an
   * invitation it would immediately forget.
   */
  readonly forumRoot: Uint8Array | undefined
  /**
   * What an invitation is currently worth, which is not the same under all three policies. Absent
   * while the policy is unknown — the panel then says nothing rather than guessing at it.
   */
  readonly policy: DmPolicyChoice | undefined
  readonly onError: (messageKey: 'shareFailed' | 'shareRevokeFailed') => void
  readonly onRevoked: () => void
}

export const DmInvitePanel = ({token, forumRoot, policy, onError, onRevoked}: DmInvitePanelProps) => {
  const {t} = useI18n()
  const {formatDate, formatDateTime} = useFormatDate()
  const [storeKey, setStoreKey] = useState<DmStoreKey | undefined>(undefined)
  const [invites, setInvites] = useState<readonly DmIssuedInvite[] | undefined>(undefined)
  const [unreadable, setUnreadable] = useState(false)
  const [shown, setShown] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (forumRoot === undefined) return
    let active = true
    void (async () => {
      try {
        const key = await run(deriveDmStoreKey(forumRoot))
        if (!active) return
        setStoreKey(key)
        const live = await run(listIssuedInvites(key, nowSeconds()))
        if (!active) return
        setUnreadable(live === undefined)
        setInvites(live ?? [])
        setShown(live?.[0]?.jti)
        logger.debug('read the invitations this device issued', {origin: ORIGIN, count: live?.length ?? 0})
      } catch (error) {
        // Deriving the key is the only throw left here; the read itself reports absence as
        // `undefined`. Either way the user must not be told they have issued nothing.
        logger.warn('the issued invitations could not be loaded', {origin: ORIGIN, error: String(error)})
        if (active) {
          setUnreadable(true)
          setInvites([])
        }
      }
    })()
    return () => {
      active = false
    }
  }, [forumRoot])

  const create = useCallback(async () => {
    if (token === undefined || storeKey === undefined) return
    setBusy(true)
    try {
      // No `bearer`: that is what makes it an invitation rather than a permit for one person.
      const issued = await dmApi.issuePermit(token, {})
      const link = buildBrandLink({feature: 'dm', useCase: 'invite', params: {permit: issued.permit}}, 'https')
      const invite: DmIssuedInvite = {
        jti: issued.jti,
        link,
        expiresAt: issued.expiresAt,
        createdAt: nowSeconds(),
      }
      // Written before it is shown: an invitation on screen but not in the book is the state that
      // loses its id, and the share sheet is one tap away.
      await run(rememberInvite(storeKey, invite, nowSeconds()))
      setInvites((current) => [invite, ...(current ?? [])])
      setShown(invite.jti)
      logger.info('created a message invitation', {origin: ORIGIN})
    } catch (error) {
      logger.error('an invitation could not be created', {origin: ORIGIN, error: String(error)})
      onError('shareFailed')
    } finally {
      setBusy(false)
    }
  }, [token, storeKey, onError])

  const revoke = useCallback(
    async (jti: string) => {
      if (token === undefined || storeKey === undefined) return
      setBusy(true)
      try {
        const revoked = await run(revokeIssuedInvite(token, storeKey, jti))
        if (!revoked) {
          onError('shareRevokeFailed')
          return
        }
        setInvites((current) => {
          const next = (current ?? []).filter((invite) => invite.jti !== jti)
          setShown((currentShown) => (currentShown === jti ? next[0]?.jti : currentShown))
          return next
        })
        onRevoked()
        logger.info('revoked a message invitation', {origin: ORIGIN})
      } finally {
        setBusy(false)
      }
    },
    [token, storeKey, onError, onRevoked],
  )

  const share = useCallback(
    async (link: string) => {
      try {
        await Share.share({message: link, title: t('forum.dm.invite.shareTitle')})
      } catch (error) {
        // A dismissed share sheet lands here too, which is not a failure worth a toast — but it is
        // worth a line, or a share that genuinely broke is indistinguishable from one declined.
        logger.debug('the share sheet closed without sharing', {origin: ORIGIN, error: String(error)})
      }
    },
    [t],
  )

  const list = invites ?? []

  return (
    <View style={styles.panel}>
      <Typography variant="bodySm_medium">{t('forum.dm.invite.shareTitle')}</Typography>
      <Typography variant="bodyXs_regular" style={styles.body}>
        {t('forum.dm.invite.shareBody')}
      </Typography>

      {/* ⚠️ The body above promises "anyone who opens this link can start a conversation with you",
          and that is only unconditionally true under `permit`. Under `open` an invitation grants
          nothing nobody already has; under `closed` the service refuses whoever opens it. Creating
          one stays possible in both — planning to change the setting afterwards is a real thing to
          do — but the consequence is stated rather than discovered by the person turned away. */}
      {policy === 'open' ? (
        <Typography variant="bodyXs_regular" style={styles.body} testID="dm-invite-note-open">
          {t('forum.dm.invite.shareRedundant')}
        </Typography>
      ) : null}
      {policy === 'closed' ? (
        <Typography variant="bodyXs_regular" style={styles.caution} testID="dm-invite-note-closed">
          {t('forum.dm.invite.sharePaused')}
        </Typography>
      ) : null}

      {unreadable ? (
        <Typography variant="bodyXs_regular" style={styles.warning} testID="dm-invite-unreadable">
          {t('forum.dm.invite.shareUnreadable')}
        </Typography>
      ) : null}

      {/* One accordion per invitation. Several look alike — same wording, and the same expiry when
          made the same day — so the header carries the creation *time*, which is the only thing that
          tells them apart, and Revoke lives inside the body where it cannot be read as belonging to
          the invitation above it. */}
      {list.map((invite, index) => (
        <Accordion
          key={invite.jti}
          title={t('forum.dm.invite.shareCreated', {date: formatDateTime(invite.createdAt * 1000)})}
          description={t('forum.dm.invite.shareExpires', {
            date: formatDate(invite.expiresAt * 1000, {dateStyle: 'medium'}),
          })}
          spacing="compact"
          isExpanded={shown === invite.jti}
          onExpandedChange={(expanded) => setShown(expanded ? invite.jti : undefined)}
          testID={`dm-invite-${index}`}
        >
          <View style={styles.invite}>
            <QRCard value={invite.link} fill testID={`dm-invite-${index}-qr`} />
            <Button
              label={t('forum.dm.invite.shareAction')}
              variant="primary"
              onPress={() => void share(invite.link)}
              testID={`dm-invite-${index}-share`}
            />
            <Button
              label={t('forum.dm.invite.shareRevoke')}
              variant="secondary"
              onPress={() => void revoke(invite.jti)}
              isDisabled={busy}
              testID={`dm-invite-${index}-revoke`}
            />
          </View>
        </Accordion>
      ))}

      {list.length > 0 ? (
        <Typography variant="bodyXs_regular" style={styles.body}>
          {t('forum.dm.invite.shareRevokeHint')}
        </Typography>
      ) : null}

      <Button
        label={t(list.length > 0 ? 'forum.dm.invite.shareCreateAnother' : 'forum.dm.invite.shareCreate')}
        variant="secondary"
        onPress={() => void create()}
        isDisabled={busy || token === undefined || storeKey === undefined}
        testID="dm-invite-create"
      />
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  panel: {gap: theme.spacing.spacing12, paddingHorizontal: theme.spacing.spacing8},
  body: {color: theme.colors.textMuted},
  warning: {color: theme.colors.errorDefault},
  caution: {color: theme.colors.warningDefault},
  invite: {gap: theme.spacing.spacing12, alignItems: 'stretch'},
}))
