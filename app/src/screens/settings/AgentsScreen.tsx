/**
 * Let an AI assistant reach this wallet, and take that access back.
 *
 * The wallet is the MCP server, so an agent needs two things: the endpoint and a credential this screen
 * issues. Both are offered three ways — a paste-whole setup block (the real path, since every MCP client
 * is configured by text on a desktop), the raw key, and a QR for an agent on a second device. The block
 * names the server after this **identity**, so pairing a second wallet with the same agent does not
 * write over the first.
 *
 * ⚠️ **The key is shown once and cannot be read back.** There is no route to re-fetch it, on purpose: one
 * would put a live credential behind a session that may be months old. Losing it means revoking and
 * issuing another, which this screen also does.
 *
 * ⚠️ **Serving is answering, not authorising.** It lasts while this screen is open — switching tabs or
 * pushing something on top keeps it alive, only closing the screen stops it — and stopping revokes
 * nothing. A paired agent stays paired and works again at the next serve; only *Revoke* takes its
 * access away. The copy said the opposite for a while, which is both wrong and the wrong model: it made
 * a toggle look as though it undid a decision made deliberately somewhere else.
 *
 * ⚠️ **A review does not interrupt it.** Routing to the review screen is a forward navigation, so this
 * screen stays mounted and the socket stays open — which is what lets an agent's `signTx` be answered
 * at all, since the reply travels back over that same socket after the person decides.
 *
 * ⚠️ Pairing is **outbound only** — nothing arrives at the phone to be acted on, which is what keeps this
 * clear of the deny-by-default deep-link table (`services/deep-link-approval.ts`).
 *
 * @module
 */

import * as Clipboard from 'expo-clipboard'
import {useCallback, useEffect, useMemo, useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Button} from '../../components/Buttons'
import {Callout} from '../../components/Callout'
import {Modal} from '../../components/Modal'
import {QRCard} from '../../components/QRCard'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {SectionHeader} from '../../components/SectionHeader'
import {SettingsGroup} from '../../components/SettingsGroup'
import {SettingsPickerRow} from '../../components/SettingsPickerRow'
import {SettingsRow} from '../../components/SettingsRow'
import {TabsWrapper} from '../../components/Tabs'
import {Toggle} from '../../components/Toggle'
import {Typography} from '../../components/Typography'
import {UniIcon} from '../../components/UniIcon'
import {useAgentCapabilities} from '../../hooks/useAgentCapabilities'
import {useMcpServing} from '../../hooks/useMcpServing'
import {logger} from '../../logger'
import {useI18n, usePnyxSession} from '../../providers'
import {useWalletList} from '../../providers/WalletProvider'
import {callLabel} from '../../services/mcp/activity'
import {
  type AgentCapabilities,
  anyGranted,
  capabilitiesForAgent,
  hasScope,
  scopeKey,
  servingBlocker,
} from '../../services/mcp/agent-capabilities'
import {
  agentConfigBlock,
  agentEndpoint,
  agentPairingUri,
  createPairing,
  forgetPairing,
  listPairings,
  type McpPairing,
  revokePairing,
} from '../../services/mcp/pairing-api'

/**
 * How many of the buffered calls to draw. The rest still count toward the rate; a list long enough to
 * need scrolling inside a settings card is paint nobody reads.
 */
const VISIBLE_CALLS = 12

const ORIGIN = 'agents-screen'

/**
 * The segmented control's value for "everyone".
 *
 * ⚠️ A sentinel rather than `''`, because the value space is pairing ids and an empty one is what a
 * malformed row would produce — the two must not collide.
 */
const SHARED_SUBJECT = '__shared__'

export function AgentsScreen() {
  const {t} = useI18n()
  const {session} = usePnyxSession()
  const token = session?.token
  /** The Pnyx identity this wallet serves as — it names the MCP server, so two wallets do not collide. */
  const identity = session?.identity
  const {selectedWalletGroup, selectedAccountIndex, walletGroups} = useWalletList()
  const {capabilities, loaded: capsLoaded, setCapabilities} = useAgentCapabilities()
  /**
   * How to name each granted scope to an agent's user, keyed the way an agent addresses it.
   *
   * Built here because only this screen knows a wallet's name; the serving layer must not reach for the
   * selected wallet to guess one.
   */
  const scopeLabels = useMemo(
    () =>
      new Map(
        walletGroups.flatMap((group) =>
          group.primaryWallet.accounts.map(
            (a) =>
              [
                scopeKey({groupId: group.groupId, accountIndex: a.index}),
                `${group.name} · Account ${a.index}`,
              ] as const,
          ),
        ),
      ),
    [walletGroups],
  )
  const {
    serving,
    connected,
    error: servingError,
    setServing,
    activity,
    callsPerMinute,
    rateCapped,
  } = useMcpServing(capabilities, scopeLabels)
  const [pairings, setPairings] = useState<readonly McpPairing[]>([])
  /**
   * Whether the list has been read successfully at least once.
   *
   * ⚠️ Without this, a failed read renders "None yet." — which says *there are none* when the truth is
   * *we could not find out*. Driving the screen on a device is what showed it: the error banner and
   * "None yet." sat one above the other.
   */
  const [listRead, setListRead] = useState(false)
  const [issued, setIssued] = useState<{label: string; token: string} | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  // Connection first, and the tab this screen opens on: serving is what someone comes here to switch,
  // where pairing happens once and access is changed rarely.
  const [tab, setTab] = useState<'agents' | 'access' | 'connection'>('connection')
  /**
   * Whose access the Access tab is editing: the shared settings, or one agent's override.
   *
   * ⚠️ **`null` is "everyone", not "no one".** The shared set is what governs every agent without an
   * override *and* every call the relay could not attribute, so it is the subject that always exists —
   * which is why it is the default here and why a pairing that is revoked while being edited falls
   * back to it rather than leaving the tab editing nothing.
   */
  const [editing, setEditing] = useState<string | null>(null)
  const [subjectPickerOpen, setSubjectPickerOpen] = useState(false)

  /**
   * Seed the account scope from what the user has selected, once, when nothing is stored.
   *
   * ⚠️ The store deliberately guesses no account — a pinned index is invisible to testing — so the
   * default belongs here, where the selection is actually known. Only when the read has completed, or
   * this would overwrite a stored empty choice the user made on purpose.
   */
  useEffect(() => {
    const groupId = selectedWalletGroup?.groupId
    if (!capsLoaded || capabilities.shared.scopes.length > 0 || groupId === undefined) return
    setCapabilities({
      ...capabilities,
      shared: {...capabilities.shared, scopes: [{groupId, accountIndex: selectedAccountIndex}]},
    })
  }, [capsLoaded, capabilities, selectedWalletGroup, selectedAccountIndex, setCapabilities])

  const refresh = useCallback(async () => {
    if (token === undefined) return
    try {
      setPairings(await listPairings(token))
      setListRead(true)
      setError(undefined)
    } catch (e) {
      setListRead(false)
      // Reported, not swallowed: "no pairings" and "the list could not be read" are different facts and
      // an empty list renders identically for both.
      logger.warn('agent pairing list failed', {origin: ORIGIN, error: String(e)})
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [token])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const onPair = useCallback(async () => {
    if (token === undefined) return
    setBusy(true)
    try {
      const label = `Agent ${new Date().toISOString().slice(11, 19)}`
      const {token: agentToken} = await createPairing(token, label)
      setIssued({label, token: agentToken})
      setError(undefined)
      await refresh()
    } catch (e) {
      logger.warn('agent pairing create failed', {origin: ORIGIN, error: String(e)})
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [token, refresh])

  const onRevoke = useCallback(
    async (pairingId: string) => {
      if (token === undefined) return
      setBusy(true)
      try {
        await revokePairing(token, pairingId)
        // Clear the shown key if it belonged to what was just revoked — leaving it on screen would
        // invite pasting a credential that no longer works.
        setIssued(undefined)
        await refresh()
      } catch (e) {
        logger.warn('agent pairing revoke failed', {origin: ORIGIN, error: String(e)})
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [token, refresh],
  )

  /**
   * Forget every revoked pairing.
   *
   * ⚠️ **Revoked only**, and the service enforces that rather than this button: a live pairing is a
   * working agent, and clearing history must never be able to cut one off. One action rather than a
   * per-row control, because these are cleared in a batch or not at all.
   */
  const onClearRevoked = useCallback(async () => {
    if (token === undefined) return
    const dead = pairings.filter((p) => p.revokedAt !== null)
    if (dead.length === 0) return
    setBusy(true)
    try {
      for (const p of dead) await forgetPairing(token, p.pairingId)
      await refresh()
    } catch (e) {
      logger.warn('clearing revoked agent pairings failed', {origin: ORIGIN, error: String(e)})
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [token, pairings, refresh])

  /**
   * ⚠️ **Two names for the same thing, deliberately.** `tag` is what the log records and `label` is
   * what the person reads — the failure message names what did not copy, so it has to be translated,
   * and a log line that changed language with the app's locale would be ungreppable.
   */
  const copy = useCallback(
    async (value: string, what: {readonly tag: string; readonly label: string}) => {
      try {
        await Clipboard.setStringAsync(value)
        logger.debug('agent pairing copied', {origin: ORIGIN, what: what.tag})
      } catch (e) {
        logger.warn('agent pairing copy failed', {origin: ORIGIN, what: what.tag, error: String(e)})
        setError(t('agents.copyFailed', {what: what.label}))
      }
    },
    [t],
  )

  const servingState = !serving
    ? t('agents.servingOff')
    : connected
      ? t('agents.servingOn')
      : t('agents.servingConnecting')

  /**
   * The subject actually being edited.
   *
   * ⚠️ Derived rather than stored, so a pairing revoked while its access was open falls back to the
   * shared set instead of leaving the toggles writing an override nothing can ever use.
   */
  const editingLive =
    editing !== null && pairings.some((p) => p.pairingId === editing && p.revokedAt === null) ? editing : null
  /** The set the toggles below read and write — the shared one, or the override being edited. */
  const edited = capabilitiesForAgent(capabilities, editingLive ?? undefined)
  const overridden = editingLive !== null && capabilities.perAgent[editingLive] !== undefined
  /**
   * Write the edited set back where it came from.
   *
   * ⚠️ Editing an agent that has no override **creates** one, seeded from the shared set — so the
   * first toggle changes only what was touched, rather than resetting the rest to the defaults.
   */
  const setEdited = (next: AgentCapabilities) =>
    setCapabilities(
      editingLive === null
        ? {...capabilities, shared: next}
        : {...capabilities, perAgent: {...capabilities.perAgent, [editingLive]: next}},
    )
  /** Drop an override, putting that agent back under the shared settings. */
  const clearOverride = () => {
    if (editingLive === null) return
    const {[editingLive]: _dropped, ...rest} = capabilities.perAgent
    setCapabilities({...capabilities, perAgent: rest})
  }

  /**
   * The subjects the Access tab can edit: everyone, then each live pairing.
   *
   * ⚠️ Live only. A revoked pairing cannot call, so offering to set its access would be a control over
   * nothing — and {@link editing} falls back to the shared set if the one being edited is revoked.
   */
  const accessSubjects = [
    {label: t('agents.accessEveryone'), sublabel: t('agents.accessEveryoneSub'), value: SHARED_SUBJECT},
    ...pairings
      .filter((p) => p.revokedAt === null)
      .map((p) => ({
        label: p.label,
        sublabel:
          capabilities.perAgent[p.pairingId] === undefined ? t('agents.accessFollowsShared') : t('agents.accessHasOwn'),
        value: p.pairingId,
      })),
  ]
  const editingLabel = pairings.find((p) => p.pairingId === editingLive)?.label ?? ''
  /**
   * The subject named on the trigger row.
   *
   * Falls back to the first entry — "Everyone", which always exists — so a pairing revoked while its
   * access was open cannot leave the row naming an agent that is gone.
   */
  const currentSubject =
    accessSubjects.find((subject) => subject.value === (editingLive ?? SHARED_SUBJECT)) ?? accessSubjects[0]

  const livePairings = pairings.filter((p) => p.revokedAt === null).length
  const revokedPairings = pairings.length - livePairings
  const blocker = servingBlocker(anyGranted(capabilities))
  /**
   * Every wallet-and-account pair, flat, so a scope is chosen from what exists rather than typed.
   *
   * ⚠️ Across *all* wallets, not the selected one: the grant names a wallet as well as an account, and
   * two wallets both have an account 0.
   */
  const flatScopes = walletGroups.flatMap((group) =>
    group.primaryWallet.accounts.map((a) => {
      const scope = {groupId: group.groupId, accountIndex: a.index}
      return {key: scopeKey(scope), scope, groupId: group.groupId, walletName: group.name, accountIndex: a.index}
    }),
  )

  return (
    <SafeAreaViewWrapper edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content} testID="agents-screen">
        <TabsWrapper
          tabs={[
            {key: 'connection', label: t('agents.tabConnection')},
            // Badged with *live* pairings, not all of them: a revoked row is history, and counting it
            // would say this wallet is reachable by agents it has cut off.
            {key: 'agents', label: t('agents.tabAgents'), ...(livePairings === 0 ? {} : {badge: livePairings})},
            {key: 'access', label: t('agents.tabAccess')},
          ]}
          activeTab={tab}
          onTabChange={(key) => setTab(key as 'agents' | 'access' | 'connection')}
          testID="agents-tabs"
        />

        {error === undefined ? null : (
          <Typography variant="bodySm_regular" style={styles.error} testID="agents-error">
            {error}
          </Typography>
        )}

        {tab === 'access' ? (
          <>
            <Typography variant="bodySm_regular" style={styles.muted}>
              {t('agents.accessIntro')}
            </Typography>
            {/* Only once there is an agent to single out: with none paired, "Everyone" is the only
                subject there could be and a control with one option is noise. */}
            {accessSubjects.length > 1 ? (
              <>
                <View style={styles.section}>
                  <SectionHeader title={t('agents.accessSubjectLabel')} />
                  {/* ⚠️ **One row that opens a sheet, not a control that grows with the list.** Segments
                      divide the width equally and clip to one line, and a row per agent would push the
                      toggles — the thing this tab is for — below however many are paired. This stays one
                      row whatever the count; the sheet is the app's canonical single-select. */}
                  <SettingsGroup>
                    <SettingsRow
                      label={currentSubject?.label ?? t('agents.accessEveryone')}
                      description={currentSubject?.sublabel ?? t('agents.accessEveryoneSub')}
                      onPress={() => setSubjectPickerOpen(true)}
                      showBorder={false}
                      testID="agents-access-subject"
                    >
                      <UniIcon
                        name="rightThin"
                        width={12}
                        height={12}
                        uniProps={(theme) => ({color: theme.colors.textMuted})}
                      />
                    </SettingsRow>
                  </SettingsGroup>
                </View>
                <Typography variant="bodySm_regular" style={styles.muted}>
                  {editingLive === null
                    ? t('agents.accessSharedNote')
                    : overridden
                      ? t('agents.accessOverrideNote', {agent: editingLabel})
                      : t('agents.accessInheritingNote', {agent: editingLabel})}
                </Typography>
                {overridden ? (
                  <Button
                    variant="secondary"
                    label={t('agents.accessUseShared')}
                    onPress={clearOverride}
                    testID="agents-access-use-shared"
                  />
                ) : null}
              </>
            ) : null}
            {blocker === undefined ? null : (
              <Callout
                variant="warning"
                message={blocker === 'no-chain' ? t('agents.blockedNoChain') : t('agents.blockedNoScope')}
                testID="agents-access-blocked"
              />
            )}
            <SettingsGroup label={t('agents.chainsLabel')}>
              <SettingsRow
                label={t('agents.cardano')}
                description={t('agents.cardanoDescription')}
                testID="agents-cardano-row"
              >
                <Toggle
                  checked={edited.cardano}
                  onChange={(next) => setEdited({...edited, cardano: next})}
                  testID="agents-cardano-toggle"
                />
              </SettingsRow>
              <SettingsRow
                label={t('agents.midnight')}
                description={t('agents.midnightDescription')}
                showBorder={false}
                testID="agents-midnight-row"
              >
                <Toggle
                  checked={edited.midnight}
                  onChange={(next) => setEdited({...edited, midnight: next})}
                  testID="agents-midnight-toggle"
                />
              </SettingsRow>
            </SettingsGroup>
            <SettingsGroup label={t('agents.dataLabel')}>
              <SettingsRow
                label={t('agents.history')}
                description={t('agents.historyDescription')}
                showBorder={false}
                testID="agents-history-row"
              >
                <Toggle
                  checked={edited.history}
                  onChange={(next) => setEdited({...edited, history: next})}
                  testID="agents-history-toggle"
                />
              </SettingsRow>
            </SettingsGroup>
            <View style={styles.section}>
              <SectionHeader title={t('agents.accountsLabel')} />
              {/* One list, each row naming its wallet and account together: a heading per wallet made
                  a one-account wallet cost two lines to say one thing, and the whole choice is a
                  single multi-select across wallets rather than several lists. */}
              <SettingsGroup>
                {flatScopes.map((entry, i) => (
                  <SettingsRow
                    key={entry.key}
                    label={t('agents.walletAccountName', {wallet: entry.walletName, index: entry.accountIndex})}
                    showBorder={i < flatScopes.length - 1}
                    testID={`agents-scope-${entry.groupId}-${entry.accountIndex}-row`}
                  >
                    {/* Multi-select, not a picker: an agent building a multiparty transaction needs
                        more than one, and they may be in different wallets. */}
                    <Toggle
                      checked={hasScope(edited, entry.scope)}
                      onChange={(next) =>
                        setEdited({
                          ...edited,
                          scopes: next
                            ? [...edited.scopes, entry.scope]
                            : edited.scopes.filter((s) => scopeKey(s) !== entry.key),
                        })
                      }
                      testID={`agents-scope-${entry.groupId}-${entry.accountIndex}-toggle`}
                    />
                  </SettingsRow>
                ))}
              </SettingsGroup>
            </View>
            <Typography variant="bodySm_regular" style={styles.muted}>
              {t('agents.accountsDescription')}
            </Typography>
          </>
        ) : tab === 'agents' ? (
          <>
            {/* In the Agents tab, where pairing happens — the decision these words are about. */}
            <Typography variant="bodySm_regular" style={styles.muted}>
              {t('agents.intro')}
            </Typography>
            <Callout variant="warning" message={t('agents.exposure')} testID="agents-exposure" />

            {token === undefined ? (
              <Typography variant="bodyMd_regular" testID="agents-signed-out">
                {t('agents.signedOut')}
              </Typography>
            ) : (
              <Button
                label={busy ? t('agents.working') : t('agents.pair')}
                variant="secondary"
                onPress={() => void onPair()}
                disabled={busy}
                fullWidth
                testID="agents-pair-button"
              />
            )}

            {issued === undefined ? null : (
              <View style={styles.card} testID="agents-issued">
                <Typography variant="bodyLg_semibold">{issued.label}</Typography>
                <Callout variant="warning" message={t('agents.issuedOnce')} />
                <Button
                  label={t('agents.copyConfig')}
                  variant="secondary"
                  onPress={() =>
                    void copy(agentConfigBlock(issued.token, identity), {
                      tag: 'config',
                      label: t('agents.whatSetupBlock'),
                    })
                  }
                  fullWidth
                  testID="agents-copy-config"
                />
                <Button
                  label={t('agents.copyToken')}
                  variant="nakedDefault"
                  onPress={() => void copy(issued.token, {tag: 'token', label: t('agents.whatKey')})}
                  fullWidth
                  testID="agents-copy-token"
                />
                {/* The two halves of the setup block, for a client that is configured field by field
                    rather than by pasting one object. The address is the same for every pairing on
                    this deployment; the key is not. */}
                <Button
                  label={t('agents.copyUrl')}
                  variant="nakedDefault"
                  onPress={() => void copy(agentEndpoint(), {tag: 'url', label: t('agents.whatUrl')})}
                  fullWidth
                  testID="agents-copy-url"
                />
                {/* `fill`, like the co-signer and UR frames: this is the densest code the app makes (a
                    JWT puts it at version 18, 89 modules), and a fixed 200 pt leaves each module
                    2.25 pt. */}
                <QRCard value={agentPairingUri(issued.token, identity)} fill testID="agents-qr" />
                <Typography variant="bodySm_regular" style={styles.muted}>
                  {t('agents.qrHint')}
                </Typography>
              </View>
            )}

            <View style={styles.section}>
              <SectionHeader
                title={t('agents.pairedTitle')}
                {...(revokedPairings === 0
                  ? {}
                  : {
                      rightSlot: (
                        <Button
                          label={t('agents.clearRevoked', {count: revokedPairings})}
                          variant="nakedDefault"
                          onPress={() => void onClearRevoked()}
                          disabled={busy}
                          testID="agents-clear-revoked"
                        />
                      ),
                    })}
              />
              <View style={styles.sectionBody}>
                {!listRead ? (
                  <Typography variant="bodySm_regular" style={styles.muted} testID="agents-paired-unknown">
                    {t('agents.pairedUnreadable')}
                  </Typography>
                ) : pairings.length === 0 ? (
                  <Typography variant="bodySm_regular" style={styles.muted} testID="agents-paired-empty">
                    {t('agents.pairedEmpty')}
                  </Typography>
                ) : (
                  <SettingsGroup>
                    {pairings.map((p, i) => (
                      <SettingsRow
                        key={p.pairingId}
                        label={p.label}
                        description={`${p.revokedAt === null ? t('agents.active') : t('agents.revoked')} · ${new Date(
                          p.createdAt,
                        )
                          .toISOString()
                          .slice(0, 16)}`}
                        showBorder={i < pairings.length - 1}
                        testID={`agents-pairing-${p.pairingId}`}
                      >
                        {p.revokedAt === null ? (
                          <Button
                            label={t('agents.revoke')}
                            variant="nakedDefault"
                            onPress={() => void onRevoke(p.pairingId)}
                            disabled={busy}
                            testID={`agents-revoke-${p.pairingId}`}
                          />
                        ) : null}
                      </SettingsRow>
                    ))}
                  </SettingsGroup>
                )}
              </View>
            </View>
          </>
        ) : (
          <>
            <Typography variant="bodySm_regular" style={styles.muted}>
              {t('agents.servingIntro')}
            </Typography>
            <Typography variant="bodyMd_regular" testID="agents-serving-state">
              {servingState}
            </Typography>
            {blocker === undefined ? null : (
              <Callout
                variant="warning"
                message={blocker === 'no-chain' ? t('agents.blockedNoChain') : t('agents.blockedNoScope')}
                testID="agents-serving-blocked"
              />
            )}
            <Button
              label={serving ? t('agents.serveStop') : t('agents.serveStart')}
              variant={serving ? 'nakedDefault' : 'secondary'}
              onPress={() => setServing(!serving)}
              // ⚠️ Disabled rather than left to fail: granting nothing and opening a socket leaves an
              // agent talking to a wallet that refuses every call, which reads as broken.
              disabled={token === undefined || blocker !== undefined}
              fullWidth
              testID="agents-serving-toggle"
            />
            {servingError === undefined ? null : (
              <Typography variant="bodySm_regular" style={styles.error} testID="agents-serving-error">
                {t(servingError)}
              </Typography>
            )}
            {serving ? (
              <View style={styles.section}>
                <SectionHeader
                  title={t('agents.activityTitle')}
                  trailingText={
                    rateCapped
                      ? t('agents.activityRateCapped', {count: callsPerMinute})
                      : t('agents.activityRate', {count: callsPerMinute})
                  }
                />
                <View style={styles.card} testID="agents-activity">
                  {activity.length === 0 ? (
                    <Typography variant="bodySm_regular" style={styles.muted}>
                      {t('agents.activityIdle')}
                    </Typography>
                  ) : (
                    activity.slice(0, VISIBLE_CALLS).map((call) => (
                      <View key={`${call.at}-${call.method}-${call.ms}`} style={styles.row}>
                        <Typography variant="bodySm_regular" style={styles.rowText} numberOfLines={1}>
                          {callLabel(call)}
                        </Typography>
                        <Typography
                          variant="bodySm_regular"
                          style={call.outcome === 'error' ? styles.error : styles.muted}
                        >
                          {call.outcome === 'ok'
                            ? t('agents.activityMs', {ms: call.ms})
                            : t(`agents.activity.${call.outcome}`)}
                        </Typography>
                      </View>
                    ))
                  )}
                </View>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
      <Modal
        visible={subjectPickerOpen}
        onClose={() => setSubjectPickerOpen(false)}
        position="bottom"
        title={t('agents.accessSubjectLabel')}
        testID="agents-access-subject-picker"
      >
        <View style={styles.pickerList}>
          {accessSubjects.map((subject) => (
            <SettingsPickerRow
              key={subject.value}
              label={subject.label}
              sublabel={subject.sublabel}
              selected={(editingLive ?? SHARED_SUBJECT) === subject.value}
              checkboxVariant="radio"
              onPress={() => {
                setEditing(subject.value === SHARED_SUBJECT ? null : subject.value)
                setSubjectPickerOpen(false)
              }}
              testID={`agents-access-subject-${subject.value}`}
            />
          ))}
        </View>
      </Modal>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  content: {padding: theme.spacing.spacing16, gap: theme.spacing.spacing12},
  // A section header sits flush on the block it labels, so the gap belongs between sections.
  section: {marginTop: theme.spacing.spacing12, gap: 0},
  // Flush under its header, like every card on this screen; the gap belongs between sections.
  sectionBody: {gap: theme.spacing.spacing12},
  // Each picker row is its own bordered card, so the list is gapped rather than sharing a wrapper.
  pickerList: {gap: theme.spacing.spacing6},
  muted: {color: theme.colors.textAlternative},
  error: {color: theme.colors.errorDefault},
  card: {gap: theme.spacing.spacing8, padding: theme.spacing.spacing12},
  row: {flexDirection: 'row', alignItems: 'center', gap: theme.spacing.spacing8},
  rowText: {flex: 1},
}))
