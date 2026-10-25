/**
 * Create a CIP-1854 shared wallet: name the co-signers by their shared account
 * key (`acct_shared_xvk…`), pick the signature policy, optionally bound it in
 * time, then derive and persist the wallet and reveal its first address.
 *
 * The roster holds account xpubs, not key hashes, so the wallet derives a fresh
 * address per index and other CIP-1854 wallets can reproduce it.
 *
 * @module
 */

import {Effect, Either} from 'effect'
import {useLocalSearchParams, useRouter} from 'expo-router'
import {useCallback, useEffect, useMemo, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../../components/Buttons/Button'
import {Callout} from '../../../components/Callout'
import {CameraScanner} from '../../../components/CameraScanner'
import {Card} from '../../../components/Card'
import {SafeAreaViewWrapper} from '../../../components/SafeAreaViewWrapper'
import {SectionHeader} from '../../../components/SectionHeader'
import {SegmentedControl} from '../../../components/SegmentedControl'
import {TextInput} from '../../../components/TextInput'
import {Typography} from '../../../components/Typography'
import {useLocalCoSignerKeys} from '../../../hooks/useLocalCoSigners'
import {useToast} from '../../../hooks/useToast'
import {logger} from '../../../logger'
import {useI18n, useWalletList} from '../../../providers'
import {getActiveCardanoNetwork} from '../../../services/cardano/config'
import {
  addressNetworkOf,
  flatTemplate,
  newSharedWalletId,
  platformSharedWalletRegistry,
  type ScriptTemplate,
  type SharedWallet,
  scriptsAt,
  validateSharedWallet,
  withTimeLock,
} from '../../../services/cardano/multisig'
import {readCoSignerKey} from '../../../services/cardano/multisig/cosigner-invite'
import {buildInviteMessage} from '../../../services/cardano/multisig/dm-message'
import {forgetDraft, loadDraft, saveDraft} from '../../../services/cardano/multisig/draft-store'
import {localWalletForKey} from '../../../services/cardano/multisig/local-cosigners'
import {
  addBlankDraft,
  adoptRestoredDrafts,
  appendCoSigner,
  clearDraft,
  draftsToRoster,
  fillFromOwnWallet,
  initialDrafts,
  inspectDrafts,
  isBlank,
  removeDraft,
  updateDraft,
} from '../../../services/cardano/multisig/roster-draft'
import {registerComposerDraft} from '../../../services/composer-draft'
import {dedupeWalletName} from '../../../utils/auto-wallet-name'
import {type CoSignerRowMessages, coSignerRowMessages, type FieldMessage} from './cosigner-row-message'
import {blockerMessageKey, createReadiness} from './create-readiness'
import {OwnWalletPickerModal} from './OwnWalletPickerModal'
import {SlotBoundField} from './SlotBoundField'
import {parseSlot} from './slot-bound'

const styles = StyleSheet.create(({spacing, colors}) => ({
  content: {padding: spacing.spacing16, gap: spacing.spacing16},
  card: {padding: spacing.spacing16},
  row: {gap: spacing.spacing8, padding: spacing.spacing16},
  blocked: {color: colors.textMuted, textAlign: 'center', paddingTop: spacing.spacing8},
  rowHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  actions: {gap: spacing.spacing8},
  fieldError: {color: colors.errorDefault},
  lockRow: {gap: spacing.spacing16},
  lockNote: {color: colors.textAlternative},
}))

type QuorumKind = 'all' | 'any' | 'atLeast'

export const CreateMultisigScreen = () => {
  const {t} = useI18n()
  const router = useRouter()
  const {cosignerKey} = useLocalSearchParams<{cosignerKey?: string}>()
  const {showToast} = useToast()
  const {selectedAccountIndex, registerSharedWalletGroup, walletGroups} = useWalletList()

  /**
   * Named from the start, never empty.
   *
   * The name identifies the wallet and nothing more — the addresses derive from
   * the roster, the templates, the network and the account index, so a rename
   * forks nothing. But it is written into the on-chain registration and it is
   * the name every other co-signer sees first, so it is worth a real default
   * rather than a required field that blocks asking anyone for a key.
   */
  const [autoName] = useState(() =>
    // `dedupeWalletName` rather than `generateAutoWalletName`: that one hardcodes
    // "My Wallet N", which is both the wrong noun for a wallet shared with other
    // people and untranslated. Kept in state so the draft restore below can tell
    // an untouched default from a name the user typed.
    dedupeWalletName(
      t('multisig.create.defaultName'),
      walletGroups.map((group) => group.name),
    ),
  )
  const [walletName, setWalletName] = useState(autoName)
  const [drafts, setDrafts] = useState(initialDrafts)
  const [quorumKind, setQuorumKind] = useState<QuorumKind>('all')
  const [required, setRequired] = useState('2')
  const [fromSlot, setFromSlot] = useState('')
  const [untilSlot, setUntilSlot] = useState('')
  const [busy, setBusy] = useState(false)
  /** Which row the wallet picker will fill, by draft id. `null` when it is closed. */
  const [pickerFor, setPickerFor] = useState<string | null>(null)
  /**
   * Which row's key is being scanned, by draft id — not a boolean.
   *
   * The scan icon lives inside a co-signer's own key field, so a scan fills *that*
   * row. Appending a new row instead would leave the field the user tapped empty
   * and the form one row longer than they asked for.
   */
  const [scanningInto, setScanningInto] = useState<string | null>(null)
  /** Collapsed until asked for — see the section below. */
  const [locksCollapsed, setLocksCollapsed] = useState(true)

  /**
   * A co-signer key handed over by another surface — today, a key that arrived
   * in a DM and was accepted there.
   *
   * Seeded once, into the initial state, rather than through an effect: a later
   * write would race the user's own edits and could re-add a row they had just
   * deleted. An unreadable value is dropped silently here because the surface
   * that produced it already parsed it — this is a handoff, not an import.
   */
  const [seededKey] = useState(() => {
    if (typeof cosignerKey !== 'string' || cosignerKey.trim() === '') return null
    const parsed = readCoSignerKey(cosignerKey)
    return Either.isRight(parsed) ? parsed.right : null
  })
  const [seeded, setSeeded] = useState(false)
  if (seededKey !== null && !seeded) {
    setSeeded(true)
    // Blank-named: the roster's names are the builder's to type, and a key
    // arriving with a name chosen by its sender is a label nobody here checked.
    setDrafts((prev) => appendCoSigner(prev, {name: '', accountXpubHex: seededKey}))
  }

  /**
   * The wallet already part-way built, restored.
   *
   * Assembling a shared wallet spans a round trip: you name it, invite someone,
   * and their key comes back minutes or days later — into a *fresh* instance of
   * this screen. Without this, that key landed in a blank form and every co-signer
   * accepted before it was lost, so a 2-of-3 could never be assembled.
   *
   * Restored once, and only over an editor the user has not touched yet
   * (`restored`), so a slow read can never overwrite something just typed. The
   * seeded key is applied on top rather than replaced by the draft — it is the
   * newer fact, and it is why this screen was opened.
   */
  const [restored, setRestored] = useState(false)
  // `autoName` is fixed at mount, so it cannot go stale here; listing it would only
  // suggest this effect can run again, which is what `restored` prevents.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-fixed state
  useEffect(() => {
    if (restored) return
    let live = true
    void Effect.runPromise(Effect.either(loadDraft())).then((result) => {
      if (!live) return
      setRestored(true)
      if (Either.isLeft(result) || result.right === null) return
      const draft = result.right
      // ⚠️ Compared against the *pre-filled* name, not against empty. The field is
      // never empty any more, so `prev === ''` silently dropped the name of every
      // wallet part-way built — the case this restore exists for.
      setWalletName((prev) => (prev === autoName && draft.walletName.trim() !== '' ? draft.walletName : prev))
      setQuorumKind(draft.quorumKind === 'any' || draft.quorumKind === 'atLeast' ? draft.quorumKind : 'all')
      setRequired(draft.required === '' ? '2' : draft.required)
      setFromSlot(draft.fromSlot)
      setUntilSlot(draft.untilSlot)
      // The restored rows first, then whatever this screen was opened to add.
      setDrafts((prev) => {
        const arrived = prev.filter((row) => !isBlank(row))
        return arrived.reduce(
          (acc, row) => appendCoSigner(acc, {name: row.name, accountXpubHex: row.key}),
          adoptRestoredDrafts(draft.rows),
        )
      })
    })
    return () => {
      live = false
    }
  }, [restored])

  /**
   * Save on every edit, once the restore has happened — writing before it would
   * persist a blank form over the draft it is about to load.
   */
  useEffect(() => {
    if (!restored) return
    void Effect.runPromise(
      Effect.ignore(saveDraft({walletName, rows: drafts, quorumKind, required, fromSlot, untilSlot})),
    )
  }, [restored, walletName, drafts, quorumKind, required, fromSlot, untilSlot])

  const network = addressNetworkOf(getActiveCardanoNetwork())
  const rows = useMemo(() => inspectDrafts(drafts), [drafts])
  /**
   * Which roster keys are ours, by xpub.
   *
   * Read from the keys cached beside each wallet's gov keys, so it costs no prompt
   * and covers every way a key can arrive — the picker, a paste, a scan, a DM.
   */
  const localKeys = useLocalCoSignerKeys()
  const isMine = useCallback(
    (accountXpubHex: string) => localWalletForKey(accountXpubHex, localKeys) !== null,
    [localKeys],
  )
  const roster = useMemo(() => draftsToRoster(drafts, isMine), [drafts, isMine])

  const template = useMemo((): ScriptTemplate | null => {
    if (roster === null) return null
    const tags = roster.map((c) => c.tag)
    const n = Number.parseInt(required, 10)
    if (quorumKind === 'atLeast' && (!Number.isInteger(n) || n < 1 || n > tags.length)) return null
    const base = flatTemplate(quorumKind === 'atLeast' ? {kind: 'atLeast', n} : {kind: quorumKind}, tags)
    const from = parseSlot(fromSlot)
    const until = parseSlot(untilSlot)
    if (!from.ok || !until.ok) return null
    return withTimeLock(base, {
      ...(from.slot !== undefined ? {from: from.slot} : {}),
      ...(until.slot !== undefined ? {until: until.slot} : {}),
    })
  }, [roster, quorumKind, required, fromSlot, untilSlot])

  const problems = useMemo(
    () =>
      roster === null || template === null
        ? []
        : validateSharedWallet({coSigners: roster, paymentTemplate: template, delegationTemplate: template}),
    [roster, template],
  )

  const readiness = useMemo(
    () =>
      createReadiness({
        name: walletName,
        draftCount: drafts.length,
        roster,
        templateValid: template !== null,
        problems,
      }),
    [walletName, drafts.length, roster, template, problems],
  )
  const canCreate = readiness.kind === 'ready' && !busy
  const blockedKey = readiness.kind === 'blocked' ? blockerMessageKey(readiness.reason) : null

  const create = useCallback(async () => {
    if (roster === null || template === null) return
    setBusy(true)
    try {
      const wallet: SharedWallet = {
        id: newSharedWalletId(),
        name: walletName.trim(),
        coSigners: roster,
        paymentTemplate: template,
        delegationTemplate: template,
        network,
        // The same value the key was derived at, so the label cannot drift from the key.
        accountIndex: selectedAccountIndex,
        // The group that actually holds one of the roster's keys, found by matching
        // xpubs rather than by remembering which wallet was picked — and never the
        // merely *active* wallet, which those two were the same value as only while
        // "you" could only be added from it. A device holding two of the wallet's
        // keys records the first; `local-cosigners` resolves the rest when signing.
        ...((): {selfGroupId?: string} => {
          const ours = roster
            .map((c) => localWalletForKey(c.accountXpubHex, localKeys)?.groupId)
            .find((id): id is string => id !== undefined)
          return ours === undefined ? {} : {selfGroupId: ours}
        })(),
        createdAt: new Date().toISOString(),
        // `skipped`, always: publishing is not asked about here. It costs a
        // transaction from a funded wallet, which a wallet that does not exist yet
        // cannot pay for — so it is offered on the wallet's own screen, where the
        // fee has a payer. `skipped` records what is true: nobody has published it.
        registration: {status: 'skipped'},
      }
      const scripts = await Effect.runPromise(scriptsAt(wallet, 0))
      await Effect.runPromise(platformSharedWalletRegistry().save(wallet))
      // Register it as a wallet group, so it appears in the wallet list and the
      // ordinary flows can select it. Idempotent on the shared wallet's id.
      await registerSharedWalletGroup({
        groupId: wallet.id,
        name: wallet.name,
        addresses: [scripts.addressBech32],
        checksumSeed: scripts.paymentScriptHashHex,
      })
      // The wallet exists now, so the draft is spent. Left behind it would
      // resurrect the finished roster the next time this screen opened.
      await Effect.runPromise(Effect.ignore(forgetDraft()))
      showToast({variant: 'success', message: t('multisig.create.created')})
      /**
       * Straight to the wallet's own screen, replacing this one.
       *
       * That screen already holds the address, the share actions and publishing,
       * so a success card here would be a second surface for the same moment —
       * and `replace` is what stops Back returning to a spent form whose draft
       * has just been forgotten.
       *
       * ⚠️ Not merely a convenience: every other co-signer gave a key and has
       * nothing to open until the definition reaches them, and this is where
       * sending it lives.
       */
      router.replace(`/wallet/shared-wallet?id=${wallet.id}` as never)
    } catch (error) {
      // The toast tells the user; this tells us which step failed. Deriving the
      // scripts, writing the registry and registering the group all land here.
      logger.warn('create shared wallet: build failed', {origin: 'CreateMultisig', error: String(error)})
      showToast({variant: 'error', message: t('multisig.create.errorBuild')})
    } finally {
      setBusy(false)
    }
  }, [
    roster,
    template,
    walletName,
    network,
    localKeys,
    registerSharedWalletGroup,
    router,
    t,
    showToast,
    selectedAccountIndex,
  ])

  /** Whether the key in this row is one of ours — `false` while the row is empty. */
  const rowIsMine = (index: number): boolean => {
    const key = rows[index]?.accountXpubHex
    return key !== null && key !== undefined && isMine(key)
  }

  const rowMessages = (index: number): CoSignerRowMessages => {
    const row = rows[index]
    return row === undefined ? {name: null, key: null} : coSignerRowMessages(row)
  }

  /** `message` / `messageVariant` / `isError` for a field, or nothing to say. */
  const messageProps = (message: FieldMessage | null) =>
    message === null ? {} : {message: t(message.key), messageVariant: message.tone, isError: message.tone === 'error'}

  const duplicate = problems.find((p) => p.kind === 'duplicate-xpub')

  /**
   * A scanned value is either a full co-signer link (key plus the name its owner
   * chose) or a bare `acct_shared_xvk`. The bare form arrives with no name, so
   * the row is added blank-named for the user to fill — inventing one would
   * later read as a name the sender picked.
   */
  /**
   * Ask someone to join, over a DM.
   *
   * The invitation is composed here — this is where the wallet's name lives —
   * but it is not *sent* here: the inbox carries it to the conversation the user
   * picks, and the thread's composer holds it until they send. Choosing who to
   * ask and asking them are two decisions, and a message that left without the
   * second one would be this app speaking in the user's voice.
   */
  const inviteOverDm = useCallback(() => {
    router.push(`/community?draft=${registerComposerDraft(buildInviteMessage())}` as never)
  }, [router])

  const onScan = useCallback(
    (data: string) => {
      const target = scanningInto
      setScanningInto(null)
      if (target === null) return
      const parsed = readCoSignerKey(data)
      if (Either.isLeft(parsed)) {
        showToast({variant: 'error', message: t('multisig.create.scanError')})
        return
      }
      setDrafts((prev) => updateDraft(prev, target, {key: parsed.right}))
    },
    [scanningInto, t, showToast],
  )

  if (scanningInto !== null) {
    return (
      <CameraScanner onScan={onScan} onCancel={() => setScanningInto(null)} hint={t('multisig.create.scanTitle')} />
    )
  }

  return (
    <SafeAreaViewWrapper edges={['bottom']} scrollable contentContainerStyle={styles.content}>
      <TextInput
        label={t('multisig.create.walletName')}
        value={walletName}
        onChange={setWalletName}
        fullWidth
        testID="multisig-name"
      />

      {duplicate !== undefined ? (
        <Callout variant="error" message={t('multisig.create.errorDuplicateKey', {name: duplicate.name})} />
      ) : null}

      {/* Above the roster, because it is what you do *before* you have one: the keys
          have to arrive before there is anything to list. It carries nothing about
          this form — just "send me your co-signer key". */}
      <Button
        label={t('multisig.create.inviteOverDm')}
        variant="secondary"
        onPress={inviteOverDm}
        isDisabled={busy}
        fullWidth
        testID="multisig-invite-dm"
      />

      {/* A section per co-signer, its own header saying which one it is and carrying
          the one action that applies to it. The rows used to be two unlabelled
          fields under a floating ✕, so on an empty form the ✕ read as belonging to
          nothing and the fields as belonging to the wallet. */}
      {drafts.map((draft, index) => (
        <View key={draft.id}>
          <SectionHeader
            title={
              // "You" follows the key, so a row filled from the picker, pasted, or
              // scanned reads the same — and two of your own wallets are both marked.
              rowIsMine(index)
                ? t('multisig.create.coSignerYou', {index: index + 1})
                : t('multisig.create.coSignerNumber', {index: index + 1})
            }
            link={
              // An empty row has nothing to clear, so it offers the one thing that
              // fills it instead. A row with something in it offers to undo that:
              // the first is cleared rather than removed, because a wallet with no
              // co-signers is not a wallet and the form must not reach that state.
              isBlank(draft)
                ? {
                    label: t('multisig.create.fromMyWallets'),
                    onPress: () => setPickerFor(draft.id),
                    testID: `cosigner-from-wallets-${index}`,
                  }
                : {
                    label: index === 0 ? t('multisig.create.clearCoSigner') : t('multisig.create.removeCoSigner'),
                    onPress: () =>
                      setDrafts((prev) => (index === 0 ? clearDraft(prev, draft.id) : removeDraft(prev, draft.id))),
                    testID: index === 0 ? 'cosigner-clear-0' : `cosigner-remove-${index}`,
                  }
            }
          />
          <Card variant="outlined" style={styles.row}>
            <TextInput
              label={t('multisig.create.coSignerName')}
              value={draft.name}
              onChange={(name) => setDrafts((prev) => updateDraft(prev, draft.id, {name}))}
              fullWidth
              testID={`cosigner-name-${index}`}
              {...messageProps(rowMessages(index).name)}
            />
            <TextInput
              label={t('multisig.create.coSignerKey')}
              {...messageProps(rowMessages(index).key)}
              value={draft.key}
              onChange={(key) => setDrafts((prev) => updateDraft(prev, draft.id, {key}))}
              autoCapitalize="none"
              autoCorrect={false}
              fullWidth
              testID={`cosigner-key-${index}`}
              // Scanning is an alternative to typing *this* key, so it lives in the
              // field it fills, and only while that field is empty — over a key
              // already entered it would offer to overwrite it by surprise. The
              // scanned row is the one whose icon was pressed.
              {...(draft.key.trim() === '' && draft.isSelf !== true
                ? {
                    rightIcon: 'scan' as const,
                    onRightIcon: () => setScanningInto(draft.id),
                    rightIconAccessibilityLabel: t('multisig.create.scan'),
                  }
                : {})}
            />
          </Card>
        </View>
      ))}

      <View style={styles.actions}>
        <Button
          label={t('multisig.create.addCoSigner')}
          variant="secondary"
          onPress={() => setDrafts(addBlankDraft)}
          fullWidth
        />
      </View>

      <OwnWalletPickerModal
        visible={pickerFor !== null}
        onClose={() => setPickerFor(null)}
        // Every key already in the roster except the row being filled — picking the
        // same wallet twice would collapse two leaves of the script into one.
        takenXpubs={rows.flatMap((r) =>
          r.accountXpubHex === null || r.draft.id === pickerFor ? [] : [r.accountXpubHex],
        )}
        onPicked={(picked) => {
          const target = pickerFor
          setPickerFor(null)
          if (target === null) return
          setDrafts((prev) => fillFromOwnWallet(prev, target, picked))
        }}
      />

      <View>
        <SectionHeader title={t('multisig.create.quorum')} />
        <SegmentedControl
          options={[
            {label: t('multisig.create.quorumAll'), value: 'all'},
            {label: t('multisig.create.quorumAny'), value: 'any'},
            {label: t('multisig.create.quorumNof'), value: 'atLeast'},
          ]}
          value={quorumKind}
          onChange={setQuorumKind}
          testID="multisig-quorum"
        />
        {quorumKind === 'atLeast' ? (
          <TextInput
            label={t('multisig.create.required')}
            value={required}
            onChange={setRequired}
            keyboardType="number-pad"
            fullWidth
            testID="multisig-required"
          />
        ) : null}
      </View>

      {/* Collapsed by default: a shared wallet with a validity window is the rare
          case, and expanded it is the tallest thing on the screen. The header says
          it is there. */}
      <View>
        <SectionHeader
          title={t('multisig.create.timeLock')}
          collapse={{
            isCollapsed: locksCollapsed,
            onToggle: () => setLocksCollapsed((collapsed) => !collapsed),
            accessibilityLabel: t('multisig.create.timeLockToggle'),
            testID: 'multisig-lock-toggle',
          }}
        />
        {locksCollapsed ? null : (
          <Card variant="outlined" style={styles.card}>
            <View style={styles.lockRow}>
              <SlotBoundField
                label={t('multisig.create.timeLockFrom')}
                slotLabel={t('multisig.create.timeLockFromSlot')}
                unboundedLabel={t('multisig.create.timeLockFromEmpty')}
                value={fromSlot}
                onChange={setFromSlot}
                testID="multisig-lock-from"
              />
              <SlotBoundField
                label={t('multisig.create.timeLockUntil')}
                slotLabel={t('multisig.create.timeLockUntilSlot')}
                unboundedLabel={t('multisig.create.timeLockUntilEmpty')}
                value={untilSlot}
                onChange={setUntilSlot}
                testID="multisig-lock-until"
              />
            </View>
            <Typography variant="bodySm_regular" style={styles.lockNote}>
              {t('multisig.create.timeLockNote')}
            </Typography>
          </Card>
        )}
        {/* Outside the fold. A window that cannot be met is a reason Create is
            refusing, and it must not be hidden behind a collapsed section. */}
        {problems.some((p) => p.kind === 'inverted-time-lock') ? (
          <Typography variant="bodySm_regular" style={styles.fieldError}>
            {t('multisig.create.errorTimeLock')}
          </Typography>
        ) : null}
      </View>

      <Button
        label={t('multisig.create.create')}
        onPress={create}
        fullWidth
        size="xl"
        isLoading={busy}
        isDisabled={!canCreate}
        testID="multisig-create"
      />
      {/* What is missing, rather than a grey button and a guess. Silent only when
          the reason already has its own callout above the form. */}
      {blockedKey === null ? null : (
        <Typography variant="bodyXs_regular" style={styles.blocked} testID="multisig-create-blocked">
          {t(blockedKey)}
        </Typography>
      )}
    </SafeAreaViewWrapper>
  )
}
