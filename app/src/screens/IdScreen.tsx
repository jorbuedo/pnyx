/**
 * Id tab — the identity home (evolved from the former pushed Profile screen).
 * Shows the identicon, account name + network, and the **Pnyx id** (copy + QR).
 * Account management (backup, passkey, sign out) now lives under the Menu tab;
 * on-chain proofs and public/private disclosure land here later with the Id-body
 * spec (docs/mobile-shell-plan.md phase 6, product/STATUS.md).
 *
 * The id shown is `C` — what a peer needs to message you — not the Midnight wallet
 * address (`docs/PNYX_IDENTITY_PLAN.md`). It comes from the Pnyx session, or the
 * persisted last-known identity after a cold start; signed-out first-run shows the
 * sign-in card.
 *
 * ⚠️ **A persisted identity does not mean a published one.** `identity` is written during onboarding
 * before any network call, so this screen used to present a complete, copyable, shareable id for a
 * device whose row never reached the chain — with no indication and no way to retry, because the only
 * retry affordance (`SignInCard`) was gated on `identity === undefined` and therefore hidden exactly
 * when it was needed. The id still renders in that state, deliberately: it is correct, and it works
 * offline. What is added is the registration status beside it — see
 * `services/identity-registration-state.ts` for why that is a real signal and not `session !==
 * undefined`.
 *
 * @module
 */

import {useFocusEffect, useRouter} from 'expo-router'
import {useCallback, useState} from 'react'
import {Pressable, Share, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Address} from '../components/Address'
import {Button} from '../components/Buttons'
import {Card} from '../components/Card'
import {Copiable} from '../components/Copiable'
import {SignInCard} from '../components/forum/SignInCard'
import {IdentityAvatar} from '../components/IdentityAvatar'
import {Modal} from '../components/Modal'
import {QRCard} from '../components/QRCard'
import {SafeAreaViewWrapper} from '../components/SafeAreaViewWrapper'
import {Tag} from '../components/Tag'
import {Typography} from '../components/Typography'
import {ValueBox} from '../components/ValueBox'
import {useContactCard} from '../hooks/useContactCard'
import {useFeatureFlag} from '../hooks/useFeatureFlag'
import {useHandleActions} from '../hooks/useHandleActions'
import {useIdentityRegistrationState} from '../hooks/useIdentityRegistrationState'
import {logger} from '../logger'
import {useI18n, usePnyxSession} from '../providers'
import {useCopy} from '../providers/CopyProvider'
import {canRetryRegistration, canWriteIdentityRow} from '../services/identity-registration-state'
import {nameLabel} from '../services/peer-name-label'
import {ContactCard} from './id/ContactCard'

export function IdScreen() {
  const {t} = useI18n()
  const {copy} = useCopy()
  const router = useRouter()
  const {session, identity, signIn, isSigningIn} = usePnyxSession()
  const registration = useIdentityRegistrationState()
  const handlesEnabled = useFeatureFlag('handles')
  const {handle, nickname, refresh: refreshHandle} = useHandleActions()
  const {entries: cardEntries, busy: cardBusy, reload: reloadCard} = useContactCard()
  // ⚠️ The claim screen has its own copy of this hook, so a name claimed there leaves this one showing
  // its mount-time answer — the tab kept offering "Claim name" for a name that was already held.
  // ⚠️ The card is re-read here too: `useContactCard` keys its read on `pnyxId`, which never changes,
  // so a read that failed once — offline, or the service down — is never retried and the card stays
  // blank for the rest of the process.
  useFocusEffect(
    useCallback(() => {
      void refreshHandle()
      void reloadCard()
    }, [refreshHandle, reloadCard]),
  )
  const [qrVisible, setQrVisible] = useState(false)
  // The same three conditions the claim card carried, now deciding the name row's trailing action.
  const claimable = handlesEnabled && handle === undefined && canWriteIdentityRow(registration)

  const pnyxId = identity?.pnyxId
  const onShare = useCallback(async () => {
    if (pnyxId === undefined) return
    try {
      await Share.share({message: pnyxId, title: t('you.shareIdTitle')})
    } catch (e: unknown) {
      // Ordinarily the user dismissing the OS share sheet, which is not worth surfacing — but a
      // share that failed for any other reason looks the same from here.
      logger.debug('Share sheet closed without sharing the pnyx_id', {origin: 'IdScreen', error: String(e)})
    }
  }, [pnyxId, t])

  return (
    <SafeAreaViewWrapper style={styles.safeArea} edges={[]} scrollable hasBottomMenu>
      <View style={styles.content}>
        <View style={styles.identiconRing}>
          <IdentityAvatar size={80} pnyxId={identity?.pnyxId} testID="id-identicon" />
        </View>
        <View style={styles.identityBlock}>
          {identity !== undefined && <Tag size="sm" label={identity.network} testID="id-network" />}
        </View>

        {identity !== undefined && canRetryRegistration(registration) && (
          <Card variant="outlined" style={styles.statusCard} testID="id-registration-status">
            <View style={styles.statusContent}>
              <Typography variant="bodyMd_medium" style={styles.statusTitle}>
                {registration === 'unregistered' ? t('you.notRegisteredTitle') : t('you.unconfirmedTitle')}
              </Typography>
              <Typography variant="bodySm_regular" style={styles.statusBody}>
                {registration === 'unregistered' ? t('you.notRegisteredHelper') : t('you.unconfirmedHelper')}
              </Typography>
              <Button
                variant="secondary"
                label={t('you.retryRegistration')}
                onPress={() => void signIn()}
                isLoading={isSigningIn}
                isDisabled={isSigningIn}
                fullWidth
                testID="id-registration-retry"
              />
            </View>
          </Card>
        )}

        {/* ⚠️ **Gated on the session, not on the identity.** An identity persists across launches and a
            session does not — and nothing signs in when the app opens already unlocked, because
            `useEnclaveUnlock` only runs when there is a lock screen to pass. Gated on `identity` this
            card was hidden in exactly the state that needs it: id on screen, no session, every write
            refused, and no way to get one. That is the same mistake this screen's own doc records
            about the registration retry, in a second place. */}
        {session === undefined && <SignInCard testID="id-sign-in" />}
        {identity === undefined ? null : (
          <Card variant="outlined" style={styles.addressCard}>
            {/* The whole row opens the details. `Address` has no `onPress` and its own modal is a
                different sheet, so it is wrapped rather than changed — the copy adornment inside
                keeps its own press, which is why the two do not fight. */}
            <View style={styles.addressContent}>
              {/* The name leads once there is one — it is how people will refer to you — but the id
                  stays on the card beside it, because the name is a label and the id is the thing it
                  labels. Each row opens its **own** sheet: releasing a name has nothing to do with
                  the id, and one shared sheet put that action behind both. */}
              {nickname !== undefined && (
                <Copiable
                  // ⚠️ The label, not the bare name: `@alice` once a handle backs it, plain text
                  // until then. One rule, in `peer-name-label`, so this and every peer surface agree.
                  text={nameLabel(nickname, handle === nickname)}
                  title={t('you.handle.title')}
                  titleFlex={LABEL_FLEX}
                  feedback={t('you.handle.copied')}
                  // ⚠️ **The row's own action is about the name it shows, and the flag is not part of
                  // that.** It used to branch on `handlesEnabled` and send a flag-on build to
                  // `/id/manage` — held names, claim another, transfer — which cannot change the
                  // name you show at all, so with the vertical on there was no way to edit a
                  // nickname from this tab. Held or not is the question that matters: an unregistered
                  // name is edited, a registered one is managed.
                  onPress={() => router.push(handle === undefined ? '/id/nickname' : '/id/manage')}
                  // While the name is unclaimed, claiming it is the action worth the trailing slot —
                  // so the offer sits on the name itself instead of in a card below repeating it.
                  // Copying comes back once a handle backs the name, which is when there is a
                  // `@name` other people can be given.
                  {...(claimable
                    ? {
                        trailing: (
                          <Button
                            label={t('you.handle.claim')}
                            variant="secondary"
                            // `sm` rather than `xs`: `xs` drives its height from 11px of vertical
                            // padding, which is tuned for a 3-up bottom bar and far too tall beside
                            // a single line of text. `sm` is a fixed 32px box; the only thing it
                            // wants here is room at the sides.
                            size="sm"
                            containerStyles={styles.claimButton}
                            onPress={() => router.push('/id/name')}
                            testID="id-handle-open-claim"
                          />
                        ),
                      }
                    : {})}
                  testID="id-handle-row"
                >
                  <Typography variant="bodyMd_regular" numberOfLines={1} testID="id-handle-current">
                    {nameLabel(nickname, handle === nickname)}
                  </Typography>
                </Copiable>
              )}
              <Pressable
                onPress={() => setQrVisible(true)}
                accessibilityRole="button"
                accessibilityLabel={t('you.showQr')}
                testID="id-identity-row"
              >
                {/* `Address` pre-slices the lead rather than leaning on `numberOfLines`, so the value
                    gets one ellipsis instead of the middle-truncation-plus-overflow pair that
                    `formatAuthor` + `numberOfLines` produced here. */}
                <Address
                  address={identity.pnyxId}
                  title={t('you.pnyxIdLabel')}
                  titleFlex={LABEL_FLEX}
                  showModal={false}
                  feedback={t('you.idCopied')}
                />
              </Pressable>
            </View>
          </Card>
        )}
        {/* The claim offer lives on the name row above rather than in a card of its own. Both write
            `identity(C)`, so it is not offered until the row is known to exist — see
            `canWriteIdentityRow`. Offering a claim an unpublished identity cannot complete is the
            same lie as showing a copyable id for a row that was never published. And it is behind
            the `handles` flag: registering a name needs a permit, and permits need a deployed
            payment contract, which the mainnet launch does not have. The nickname renders either
            way — that is the whole point of the split. */}
        {/* Below the name, because a card is what someone finds *after* they have found you. */}
        {canWriteIdentityRow(registration) && <ContactCard entries={cardEntries} busy={cardBusy} />}
        {/* A citizen appears only when the card names one — this is a row people opt into, not a
            feature the tab asserts. */}
      </View>

      {identity !== undefined && (
        <Modal visible={qrVisible} onClose={() => setQrVisible(false)} position="bottom" testID="id-qr-modal">
          <View style={styles.qrContainer}>
            <QRCard value={identity.pnyxId} size={200} testID="id-qr-code" />
            <ValueBox label={t('you.pnyxIdLabel')} value={identity.pnyxId} testID="id-qr-value" />
            <View style={styles.qrActions}>
              <Button
                variant="primary"
                label={t('you.copyId')}
                leftIcon="copy"
                fullWidth
                onPress={() => copy({text: identity.pnyxId, feedback: t('you.idCopied')})}
                testID="id-qr-copy"
              />
              <Button
                variant="secondary"
                label={t('you.shareId')}
                leftIcon="shareOutline"
                fullWidth
                onPress={() => void onShare()}
                testID="id-qr-share"
              />
            </View>
          </View>
        </Modal>
      )}
    </SafeAreaViewWrapper>
  )
}

/**
 * How much of a label:value row the label takes, against the value's `1`.
 *
 * ⚠️ **Both rows must pass it.** The name and the id sit one above the other, so a row that takes the
 * `Copiable` default of an even split starts its value in a different column *and* truncates a name
 * that would otherwise fit — the label is short, the value is not.
 */
const LABEL_FLEX = 0.55

const styles = StyleSheet.create((theme) => ({
  safeArea: {
    flex: 1,
  },
  claimButton: {
    paddingHorizontal: theme.spacing.spacing12,
  },
  content: {
    paddingHorizontal: theme.spacing.spacing16,
    paddingTop: theme.spacing.spacing24,
    gap: theme.spacing.spacing16,
    alignItems: 'center',
  },
  identiconRing: {
    width: 80 + theme.spacing.spacing8,
    height: 80 + theme.spacing.spacing8,
    borderRadius: theme.borderRadius.roundedCircle,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.backgroundAlternative,
  },
  identityBlock: {
    gap: theme.spacing.spacing8,
    alignItems: 'center',
  },
  muted: {color: theme.colors.textAlternative},
  addressCard: {
    padding: theme.spacing.spacing12,
    alignSelf: 'stretch',
  },
  statusCard: {
    padding: theme.spacing.spacing12,
    alignSelf: 'stretch',
  },
  statusContent: {
    gap: theme.spacing.spacing8,
  },
  statusTitle: {
    color: theme.colors.warningDefault,
  },
  statusBody: {
    color: theme.colors.textAlternative,
  },
  addressContent: {
    gap: theme.spacing.spacing8,
  },
  qrContainer: {
    alignItems: 'center',
    gap: theme.spacing.spacing16,
  },
  qrActions: {
    width: '100%',
    gap: theme.spacing.spacing8,
  },
}))
