/**
 * Messaging settings: who may start a conversation with you, and who cannot reach you at all.
 *
 * The rules are the service's (`docs/ABUSE_MITIGATION.md` §5); this screen only sets and shows them.
 * Two settings with genuinely different shapes, which is why they are two groups rather than one
 * list: the policy is about strangers in general, a block is about one person.
 *
 * ⚠️ **Muting is not here**, deliberately. It belongs to a conversation, so it lives in that
 * thread's ⋮ menu — a global list of muted threads would be a list of who you talk to, which is the
 * one thing this whole design avoids keeping.
 *
 * @module
 */

import {useCallback, useEffect, useState} from 'react'
import {ActivityIndicator, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {EmptyState} from '../../src/components/EmptyState'
import {DmInvitePanel} from '../../src/components/forum/DmInvitePanel'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {SettingsGroup} from '../../src/components/SettingsGroup'
import {SettingsPickerRow} from '../../src/components/SettingsPickerRow'
import {SettingsRow} from '../../src/components/SettingsRow'
import {Typography} from '../../src/components/Typography'
import {usePeerHandles} from '../../src/hooks/usePeerHandles'
import {useToast} from '../../src/hooks/useToast'
import {logger} from '../../src/logger'
import {useI18n, usePnyxSession} from '../../src/providers'
import {type DmPolicyChoice, dmApi} from '../../src/services/dm-api'
import {formatAuthor} from '../../src/services/pnyx-forum'

const ORIGIN = 'settings/messaging'

/** The three policies, in the order they widen: most private first is not the useful order here. */
const POLICIES: readonly DmPolicyChoice[] = ['open', 'permit', 'closed']

const LABELS: Record<DmPolicyChoice, 'policyOpen' | 'policyPermit' | 'policyClosed'> = {
  open: 'policyOpen',
  permit: 'policyPermit',
  closed: 'policyClosed',
}

const DESCRIPTIONS: Record<DmPolicyChoice, 'policyOpenBody' | 'policyPermitBody' | 'policyClosedBody'> = {
  open: 'policyOpenBody',
  permit: 'policyPermitBody',
  closed: 'policyClosedBody',
}

export default function MessagingSettingsScreen() {
  const {t} = useI18n()
  const {showToast} = useToast()
  const {session} = usePnyxSession()

  const [policy, setPolicy] = useState<DmPolicyChoice | undefined>(undefined)
  const [blocks, setBlocks] = useState<readonly {peer: string; createdAt: string}[] | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [read, setRead] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [attempt, setAttempt] = useState(0)

  const token = session?.token

  /**
   * What the screen may draw.
   *
   * ⚠️ **Nothing but `ready` may draw the rows.** A read that did not land leaves every radio
   * unselected and every tap swallowed by the write guard, so the three policies rendered as a live
   * picker that cannot be operated and the blocked list asserted "you have not blocked anyone" —
   * which is a claim about the server, from a device that never heard back.
   */
  const view = token === undefined ? 'signedOut' : read

  // Resolved for the whole list at once, and retried on the session for the reason `usePeerHandles`
  // documents. `blocks` is undefined until the read lands, which resolves to no lookups.
  const handles = usePeerHandles(blocks === undefined ? [] : blocks.map((block) => block.peer), token)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is a re-run trigger, not a read
  useEffect(() => {
    if (token === undefined) return
    let active = true
    setRead('loading')
    void (async () => {
      try {
        const [current, blocked] = await Promise.all([dmApi.readPolicy(token), dmApi.listBlocks(token)])
        if (!active) return
        setPolicy(current)
        setBlocks(blocked)
        setRead('ready')
        // A read that populates the whole screen: silent on success, it cannot be told apart from
        // one that never ran — and "no blocks" and "never loaded" draw identically.
        logger.debug('messaging settings read', {origin: ORIGIN, policy: current, blocks: blocked.length})
      } catch (error) {
        // The screen shows nothing rather than a guess: rendering "open" for a read that failed
        // would tell someone they are reachable when they may have chosen not to be.
        logger.warn('messaging settings could not be read', {origin: ORIGIN, error: String(error)})
        if (!active) return
        setRead('failed')
        // Kept alongside the inline state: a retry that fails again would otherwise look like a
        // button that does nothing, since the screen it returns to is the one it started from.
        showToast({variant: 'error', message: t('settings.messaging.unreachable')})
      }
    })()
    return () => {
      active = false
    }
  }, [token, attempt, showToast, t])

  const choose = useCallback(
    async (next: DmPolicyChoice) => {
      if (token === undefined || next === policy) return
      setBusy(true)
      const previous = policy
      setPolicy(next)
      try {
        await dmApi.writePolicy(token, next)
        logger.info('message policy changed', {origin: ORIGIN, policy: next})
      } catch (error) {
        logger.error('the message policy could not be saved', {origin: ORIGIN, error: String(error)})
        // Put the row back: a checkmark that did not persist is a promise the app cannot keep.
        setPolicy(previous)
        showToast({variant: 'error', message: t('settings.messaging.saveFailed')})
      } finally {
        setBusy(false)
      }
    },
    [token, policy, showToast, t],
  )

  const unblock = useCallback(
    async (peer: string) => {
      if (token === undefined) return
      setBusy(true)
      try {
        await dmApi.unblockPeer(token, peer)
        setBlocks((current) => (current ?? []).filter((b) => b.peer !== peer))
        // ⚠️ No peer id in the line. Blocking a person is the one plaintext pair this design keeps,
        // and a device log is not a place to copy it to.
        logger.info('a block was lifted', {origin: ORIGIN})
        showToast({variant: 'success', message: t('settings.messaging.unblocked')})
      } catch (error) {
        logger.error('the block could not be lifted', {origin: ORIGIN, error: String(error)})
        showToast({variant: 'error', message: t('settings.messaging.unblockFailed')})
      } finally {
        setBusy(false)
      }
    },
    [token, showToast, t],
  )

  if (view !== 'ready') {
    return (
      <SafeAreaViewWrapper style={styles.safeArea} edges={['bottom']} contentContainerStyle={styles.scrollContent}>
        {view === 'loading' ? (
          <View style={styles.loading}>
            <ActivityIndicator />
          </View>
        ) : (
          <EmptyState
            icon="warning"
            title={t(
              view === 'signedOut' ? 'settings.messaging.signedOutTitle' : 'settings.messaging.unavailableTitle',
            )}
            description={t(
              view === 'signedOut' ? 'settings.messaging.signedOutBody' : 'settings.messaging.unavailableBody',
            )}
            // No retry without a session: the button would re-read with the same missing token and
            // change nothing, and signing in is not this screen's job.
            action={
              view === 'signedOut'
                ? undefined
                : {label: t('common.buttons.tryAgain'), onPress: () => setAttempt((n) => n + 1)}
            }
            testID="messaging-unavailable"
          />
        )}
      </SafeAreaViewWrapper>
    )
  }

  return (
    <SafeAreaViewWrapper
      style={styles.safeArea}
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.scrollContent}
    >
      <SettingsGroup label={t('settings.messaging.policySection')} variant="stacked">
        {POLICIES.map((choice) => (
          <SettingsPickerRow
            key={choice}
            label={t(`settings.messaging.${LABELS[choice]}`)}
            sublabel={t(`settings.messaging.${DESCRIPTIONS[choice]}`)}
            selected={policy === choice}
            onPress={() => {
              if (!busy) void choose(choice)
            }}
            testID={`messaging-policy-${choice}`}
            checkboxVariant="radio"
          />
        ))}
      </SettingsGroup>

      <SettingsGroup label={t('settings.messaging.inviteSection')}>
        <DmInvitePanel
          token={token}
          forumRoot={session?.forumRoot}
          policy={policy}
          onError={(key) => showToast({variant: 'error', message: t(`forum.dm.invite.${key}`)})}
          onRevoked={() => showToast({variant: 'success', message: t('forum.dm.invite.shareRevoked')})}
        />
      </SettingsGroup>

      <SettingsGroup label={t('settings.messaging.blockedSection')}>
        {blocks === undefined || blocks.length === 0 ? (
          <View style={styles.empty}>
            <Typography variant="bodySm_regular" style={styles.emptyText}>
              {t('settings.messaging.noBlocks')}
            </Typography>
          </View>
        ) : (
          blocks.map((block, index) => {
            // ⚠️ **The id stays on screen whenever a handle replaced it**, exactly as the thread
            // header does it. Handles are confusable by construction — the naming policy answers
            // script mixing, not lookalikes inside one script — and the mistake this list invites is
            // unblocking the wrong person, so what actually identifies them cannot be the thing that
            // disappears.
            const handle = handles.get(block.peer)
            const shortId = formatAuthor(block.peer, 20)
            return (
              <SettingsRow
                key={block.peer}
                label={handle ?? shortId}
                description={
                  handle === undefined
                    ? t('settings.messaging.unblockHint')
                    : t('settings.messaging.unblockHintWithId', {id: shortId})
                }
                onPress={busy ? undefined : () => void unblock(block.peer)}
                showBorder={index < blocks.length - 1}
                testID={`messaging-unblock-${index}`}
              />
            )
          })
        )}
      </SettingsGroup>

      <Typography variant="bodyXs_regular" style={styles.footnote}>
        {t('settings.messaging.footnote')}
      </Typography>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {flex: 1},
  scrollContent: {padding: theme.spacing.spacing16, gap: theme.spacing.spacing16},
  empty: {paddingVertical: theme.spacing.spacing16, paddingHorizontal: theme.spacing.spacing16},
  loading: {paddingVertical: theme.spacing.spacing32, alignItems: 'center'},
  emptyText: {color: theme.colors.textMuted},
  footnote: {color: theme.colors.textMuted, paddingHorizontal: theme.spacing.spacing8},
}))
