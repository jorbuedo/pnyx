/**
 * Start a direct message, by Pnyx id or by Pnyx handle.
 *
 * Thin surface over {@link startDmConversation} — all the peer-side trust decisions live there.
 * What this screen owns is telling the truth about *why* it failed, because the outcomes are
 * genuinely different and two of them are security events.
 *
 * Peer-side ({@link DmStartFailure}):
 * - `chain-unavailable` — our build cannot reach the chain. Our limitation, not the peer's.
 * - `peer-not-published` — they have never enabled DMs. Nothing we can retry.
 * - `peer-no-key-packages` — their client needs to come online and refill. Retryable, later.
 * - `key-package-rejected` — what we were handed did not match their on-chain anchor. Shown as a
 *   warning, never as "try again", because retrying is exactly the wrong response.
 *
 * Input-side (`NameProblem`), all of which happen before a conversation is attempted:
 * - `unrecognised` — neither a valid Pnyx id nor a handle the client policy accepts. Said plainly,
 *   rather than letting it fail later as "peer not found".
 * - `handleUnclaimed` / `handleReserved` / `handleUnavailable` — the three ways an Pnyx handle can
 *   fail to name a peer, kept apart because they lead to opposite actions: take the name yourself,
 *   never (the contract reserved it), and try again shortly. Collapsing the third into the first
 *   would tell someone a held name is free.
 *
 * @module
 */

import {router, Stack, useLocalSearchParams} from 'expo-router'
import {useCallback, useEffect, useState} from 'react'
import {Pressable, ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button, ButtonIcon} from '../../src/components/Buttons'
import {ChamferBackground} from '../../src/components/Chamfer'
import {IdentityAvatar} from '../../src/components/IdentityAvatar'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {TextInputBase} from '../../src/components/TextInputBase'
import {Typography} from '../../src/components/Typography'
import {usePeerHandles} from '../../src/hooks/usePeerHandles'
import {logger} from '../../src/logger'
import {useI18n, usePnyxSession} from '../../src/providers'
import type {CirclePeer} from '../../src/services/circle-peer-index'
import {suggestedCirclePeers} from '../../src/services/circle-peer-index'
import {listCirclePeers} from '../../src/services/circle-peers'
import {DmApiError} from '../../src/services/dm-api'
import {LOCAL_SELF_CONV_ID} from '../../src/services/dm-local'
import type {DmStartFailure} from '../../src/services/dm-start'
import {startDmConversation} from '../../src/services/dm-start'
import {dmStartFailureKey} from '../../src/services/dm-start-failure-copy'
import {resolveHandle} from '../../src/services/handle-resolve'
import {classifyPeerInput} from '../../src/services/peer-input'
import {formatAuthor} from '../../src/services/pnyx-forum'

/** The input never became an identity. Distinct from the peer-side {@link DmStartFailure}s. */
type NameProblem =
  | {readonly kind: 'unrecognised'}
  /** An Pnyx handle nobody holds. A definite answer, unlike `handleUnavailable`. */
  | {readonly kind: 'handleUnclaimed'; readonly handle: string}
  /** Reserved by the contract: it will never resolve to a peer, so "try later" would be a lie. */
  | {readonly kind: 'handleReserved'; readonly handle: string}
  /** We could not read the registry. Retryable, and must not be shown as "nobody holds it". */
  | {readonly kind: 'handleUnavailable'}

export default function NewDmScreen() {
  const {t} = useI18n()
  const {session, forumRoot, identity} = usePnyxSession()
  // `peer` prefills the field when the flow was entered from a known identity — today the
  // long-press actions on a disclosed message author. It seeds the input rather than starting
  // automatically: the user still sees who they are about to open a conversation with.
  const {peer} = useLocalSearchParams<{peer?: string}>()
  const [peerInput, setPeerInput] = useState(typeof peer === 'string' ? peer : '')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<DmStartFailure | undefined>(undefined)
  // Input problems are a separate axis from `DmStartFailure`: they happen before the conversation
  // is attempted, and neither of them is a failure of the peer.
  const [nameProblem, setNameProblem] = useState<NameProblem | undefined>(undefined)
  /**
   * People this device has seen posting in a circle, as a shortcut past copying an id.
   *
   * ⚠️ **Read from the local record, never fetched.** It is sealed under the vault's `forumRoot`, so
   * the list is there with no session and no network — and it is only ever as fresh as the last circle
   * the user opened, which is the honest thing for a shortcut to be.
   */
  const [suggestions, setSuggestions] = useState<readonly CirclePeer[]>([])

  useEffect(() => {
    const root = forumRoot
    if (root === undefined) return
    let live = true
    void listCirclePeers(root).then((peers) => {
      if (live) setSuggestions(suggestedCirclePeers(peers, identity?.pnyxId ?? session?.identity))
    })
    return () => {
      live = false
    }
  }, [forumRoot, identity?.pnyxId, session?.identity])

  // Resolved for the whole list, retried on the session for the reason `usePeerHandles` documents.
  const handles = usePeerHandles(
    suggestions.map((one) => one.pnyxId),
    session?.token,
  )

  const failureMessage = (value: DmStartFailure): string => t(dmStartFailureKey(value))

  const nameProblemMessage = (value: NameProblem): string => {
    switch (value.kind) {
      case 'unrecognised':
        return t('forum.dm.startNameUnrecognised')
      case 'handleUnclaimed':
        return t('forum.dm.startHandleUnclaimed', {handle: value.handle})
      case 'handleReserved':
        return t('forum.dm.startHandleReserved', {handle: value.handle})
      default:
        return t('forum.dm.startHandleUnavailable')
    }
  }

  const open = useCallback(
    async (peerIdentity: string) => {
      // `forumRoot` is optional on the session; without it there is no DM key material at all.
      if (session?.forumRoot === undefined) return
      setBusy(true)
      const result = await startDmConversation({
        token: session.token,
        selfIdentity: session.identity,
        peerIdentity,
        forumRoot: session.forumRoot,
        network: session.network,
      })
      setBusy(false)
      if (!result.ok) {
        // Your own id is not a failure to word — it is the notes thread, which needs no group.
        if (result.failure.kind === 'self-conversation') {
          router.replace({pathname: '/dm/[convId]', params: {convId: LOCAL_SELF_CONV_ID}})
          return
        }
        // ⚠️ `kind` alone is not a diagnosis. Every named kind explains itself, but `failed` is the
        // catch-all and carries the only description of what actually went wrong — dropping it made
        // a duplicate-Welcome 500 indistinguishable from an unreachable service in the log.
        logger.error('start dm failed', {
          origin: 'NewDmScreen',
          kind: result.failure.kind,
          ...(result.failure.kind === 'failed'
            ? {
                cause: String(result.failure.cause),
                // Structured, not only inside the message: a reader that has to regex a status out
                // of a rendered string is one rewording away from never matching again.
                ...(result.failure.cause instanceof DmApiError && result.failure.cause.status !== undefined
                  ? {status: result.failure.cause.status}
                  : {}),
              }
            : {}),
        })
        setFailure(result.failure)
        return
      }
      router.replace({pathname: '/dm/[convId]', params: {convId: result.convId, peer: peerIdentity}})
    },
    [session],
  )

  const start = useCallback(async () => {
    if (session?.forumRoot === undefined) return
    setFailure(undefined)
    setNameProblem(undefined)

    const input = classifyPeerInput(peerInput)
    if (input.kind === 'empty') return
    if (input.kind === 'unrecognised') {
      setNameProblem({kind: 'unrecognised'})
      return
    }
    if (input.kind === 'handle') {
      setBusy(true)
      const resolved = await resolveHandle(input.nameKey)
      setBusy(false)
      switch (resolved.kind) {
        case 'unclaimed':
          setNameProblem({kind: 'handleUnclaimed', handle: input.handle})
          return
        case 'reserved':
          setNameProblem({kind: 'handleReserved', handle: input.handle})
          return
        case 'unavailable':
          setNameProblem({kind: 'handleUnavailable'})
          return
        default:
          // Deliberately the resolved identity, never `input.handle` — the row owns the label.
          await open(resolved.pnyxId)
          return
      }
    }
    await open(input.pnyxId)
  }, [session, peerInput, open])

  const canStart = session?.forumRoot !== undefined && peerInput.trim().length > 0 && !busy

  return (
    <SafeAreaViewWrapper style={styles.safeArea} edges={['top', 'bottom']} noPadding>
      <Stack.Screen options={{headerShown: false}} />
      <View style={styles.header}>
        <ButtonIcon
          icon="chevronLeft"
          size="md"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/community'))}
          containerProps={{accessibilityLabel: t('common.buttons.back')}}
          testID="new-dm-back"
        />
        <Typography variant="headingSm">{t('forum.dm.startTitle')}</Typography>
      </View>
      <View style={styles.body}>
        <Typography variant="bodySm_regular" style={styles.muted}>
          {t('forum.dm.startDescription')}
        </Typography>
        <View style={styles.inputWrap}>
          <ChamferBackground size="auto" fillToken="backgroundAlternative" />
          <TextInputBase
            value={peerInput}
            onChangeText={setPeerInput}
            placeholder={t('forum.dm.startPlaceholder')}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            testID="new-dm-address"
          />
        </View>
        {nameProblem !== undefined && (
          <Typography
            variant="bodySm_regular"
            // Only `unrecognised` is the user having mistyped. The three handle outcomes are
            // answers about a name that may be perfectly well-formed, so they read as notices.
            style={nameProblem.kind === 'unrecognised' ? styles.error : styles.warning}
            testID="new-dm-name-problem"
          >
            {nameProblemMessage(nameProblem)}
          </Typography>
        )}
        {failure !== undefined && (
          <Typography
            variant="bodySm_regular"
            style={failure.kind === 'key-package-rejected' ? styles.warning : styles.error}
            testID="new-dm-failure"
          >
            {failureMessage(failure)}
          </Typography>
        )}
        <Button
          label={busy ? t('forum.dm.starting') : t('forum.dm.startAction')}
          variant="primary"
          onPress={() => void start()}
          isDisabled={!canStart}
          isLoading={busy}
          fullWidth
          testID="new-dm-start"
        />
      </View>
      {/*
        The space below the button, doing something. A tap fills the field rather than starting the
        conversation: this screen's whole shape is see-who-then-confirm, and a list that opened a
        conversation on one tap would be the only place that skipped it.
      */}
      <View style={styles.suggestions}>
        <Typography variant="bodyXs_medium" style={styles.suggestionsTitle}>
          {t('forum.dm.startSuggestionsTitle')}
        </Typography>
        {suggestions.length === 0 ? (
          <Typography variant="bodyXs_regular" style={styles.muted} testID="new-dm-suggestions-empty">
            {t('forum.dm.startSuggestionsEmpty')}
          </Typography>
        ) : (
          <ScrollView contentContainerStyle={styles.suggestionList}>
            {suggestions.map((peer) => (
              <Pressable
                key={peer.pnyxId}
                onPress={() => setPeerInput(peer.pnyxId)}
                accessibilityRole="button"
                // The id, always — the same reason the inbox announces one: a screen reader reading a
                // handle inherits every confusability the identicon beside it exists to answer.
                accessibilityLabel={peer.pnyxId}
                style={({pressed}) => [styles.suggestionRow, pressed && styles.suggestionRowPressed]}
                testID={`new-dm-suggestion-${peer.pnyxId}`}
              >
                <IdentityAvatar pnyxId={peer.pnyxId} size={32} />
                <View style={styles.suggestionText}>
                  <Typography variant="bodySm_medium" numberOfLines={1}>
                    {handles.get(peer.pnyxId) ?? formatAuthor(peer.pnyxId, 20)}
                  </Typography>
                  <Typography variant="bodyXs_regular" style={styles.muted} numberOfLines={1}>
                    {t('forum.dm.startSuggestionIn', {circle: peer.circleName})}
                  </Typography>
                </View>
              </Pressable>
            ))}
          </ScrollView>
        )}
      </View>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {flex: 1},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing8,
    paddingHorizontal: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing8,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderDefaultWeak,
  },
  body: {padding: theme.spacing.spacing16, gap: theme.spacing.spacing12},
  muted: {color: theme.colors.textAlternative},
  inputWrap: {},
  suggestions: {
    flex: 1,
    paddingHorizontal: theme.spacing.spacing16,
    gap: theme.spacing.spacing8,
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderDefaultWeak,
    paddingTop: theme.spacing.spacing16,
  },
  suggestionsTitle: {color: theme.colors.textAlternative, textTransform: 'uppercase'},
  suggestionList: {gap: theme.spacing.spacing4, paddingBottom: theme.spacing.spacing16},
  suggestionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing8,
  },
  suggestionRowPressed: {opacity: 0.6},
  suggestionText: {flex: 1, gap: theme.spacing.spacing4},
  input: {
    color: theme.colors.textDefault,
    backgroundColor: 'transparent',
    paddingHorizontal: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing12,
  },
  error: {color: theme.colors.errorDefault},
  warning: {color: theme.colors.warningDefault},
}))
