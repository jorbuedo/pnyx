/**
 * Co-sign a shared multisig / multiparty transaction: import a `TxEnvelope`
 * (paste or file), see who still owes a signature, then
 * add this wallet's partial signature and either submit (quorum met) or re-export
 * for the remaining signers.
 *
 * **Signing does not happen here.** The action registers a review ticket and
 * navigates to `TxReviewScreen`, which is the one place a signature is consented
 * to (Phase 16 item 41). It needs no special confirm mode: `partialSignRequest`
 * is an ordinary `signOnly` request, so the review screen signs exactly the bytes
 * it rendered and returns this signer's witness set. Merging that witness, the
 * quorum check, and submit-or-export are this screen's job — see `afterCoSign`.
 *
 * @module
 */

import {Decode} from '@evolution-sdk/review/Decode'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {cardanoChainId} from '@pnyx/config'
import {type ResolvedInput, type ReviewedTransaction, reviewCardanoTx} from '@pnyx/tx-review'
import {Effect} from 'effect'
import * as DocumentPicker from 'expo-document-picker'
import {File, Paths} from 'expo-file-system'
import {useLocalSearchParams, useRouter} from 'expo-router'
import * as Sharing from 'expo-sharing'
import {useCallback, useEffect, useState} from 'react'
import {ActivityIndicator, Share, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../../components/Buttons/Button'
import {EmptyState} from '../../../components/EmptyState'
import {SafeAreaViewWrapper} from '../../../components/SafeAreaViewWrapper'
import {StickyFooter} from '../../../components/StickyFooter'
import {TextArea} from '../../../components/TextArea'
import {Typography} from '../../../components/Typography'
import {UniIcon} from '../../../components/UniIcon'
import {useCardanoRail} from '../../../hooks/useCardanoRail'
import {useCardanoSigningLayer} from '../../../hooks/useCardanoSigningLayer'
import {useLocalCoSigners} from '../../../hooks/useLocalCoSigners'
import {useLocalMultipartySigners} from '../../../hooks/useLocalMultipartySigners'
import {useToast} from '../../../hooks/useToast'
import {logger} from '../../../logger'
import {useI18n, useWalletList} from '../../../providers'
import {useCopy} from '../../../providers/CopyProvider'
import {
  addSignature,
  envelopeWitnessesFrom,
  keyIndexesOf,
  parseEnvelope,
  partialSignRequest,
  platformCosignRegistry,
  platformForgetCosign,
  platformPersistCosign,
  requiredFor,
  rosterByCoSigner,
  scriptRoleAt,
  serializeEnvelope,
  statusOf,
  submitEnvelope,
  type TxEnvelope,
} from '../../../services/cardano/cosign'
import {resolveInputsWithChain} from '../../../services/cardano/cosign/foreign-inputs'
import {
  addWitnessTextEnvelope,
  classifyIncoming,
  envelopeFromTxTextEnvelope,
  toTxTextEnvelope,
} from '../../../services/cardano/cosign/interop'
import {type EnvelopeChainState, envelopeChainState} from '../../../services/cardano/cosign/landed'
import {serializeTextEnvelope} from '../../../services/cardano/cosign/text-envelope'
import {consumedUtxoIdsOf} from '../../../services/cardano/cosign/track-submitted'
import {outstandingMultipartySigners} from '../../../services/cardano/multiparty'
import {ownPaymentPath, ownStakePath} from '../../../services/cardano/multisig'
import {
  awaitingCoSigners,
  type LocalCoSigner,
  outstandingLocalCoSigners,
} from '../../../services/cardano/multisig/local-cosigners'
import {resolveSharedWalletRail} from '../../../services/cardano/multisig/rail-resolution'
import type {SharedWallet} from '../../../services/cardano/multisig/types'
import {registerPendingActivity} from '../../../services/cardano/pending-activity'
import type {CardanoRail} from '../../../services/cardano/rail'
import {createCardanoTxContext, resolvedInputsFromSpendable} from '../../../services/cardano/signing-adapters'
import {ceremonyFailureReason} from '../../../services/cardano/submit-failure'
import {cardanoDecodeLayer} from '../../../services/cardano-decode-layer'
import {registerComposerDraft} from '../../../services/composer-draft'
import {registerReviewTicket} from '../review-handoff'
import {SignAsSheet} from './SignAsSheet'

/**
 * Envelopes the review has already been opened for.
 *
 * Module scope, not a ref: signing navigates to the review screen and back, which
 * *remounts* this one — a per-mount guard resets exactly when it is needed, and
 * the screen re-opens the review it just returned from, forever.
 *
 * Arriving at a transaction you still owe a signature to opens its review, since
 * seeing what you are signing should not need a tap. Once: a device holding two
 * of a wallet's keys is offered the second as a choice, and cancelling means
 * "let me look at this", not "ask me again".
 */
const autoOpenedEnvelopes = new Set<string>()

const styles = StyleSheet.create(({spacing, colors}) => ({
  content: {padding: spacing.spacing16, gap: spacing.spacing16},
  centred: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.spacing16},
  actions: {gap: spacing.spacing8},
  field: {gap: spacing.spacing4},
  fieldLabel: {color: colors.textDefault},
  waiting: {color: colors.textAlternative, textAlign: 'center', paddingVertical: spacing.spacing12},
  loading: {alignItems: 'center', justifyContent: 'center', gap: spacing.spacing8, paddingVertical: spacing.spacing24},
  signAsLabel: {color: colors.textAlternative},
  rosterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.spacing12,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDefaultWeak,
  },
  rosterName: {flex: 1},
}))

export const CoSignScreen = () => {
  const {t} = useI18n()
  const {showToast} = useToast()
  const router = useRouter()
  const {selectedWalletGroup, selectWallet} = useWalletList()
  const {copy} = useCopy()
  // The canonical rail for the selected wallet. It matters that this is the
  // shared one when a shared wallet is selected — which is exactly what happens
  // when origination hands a freshly signed envelope over — because it carries
  // the script authority: the signing request is then redirected at the group
  // that backs our co-signer key, instead of asking the vault for a seed the
  // shared wallet never had.
  const {rail: selectedRail} = useCardanoRail()
  const {resolveSigningLayer} = useCardanoSigningLayer()
  const {pendingId} = useLocalSearchParams<{pendingId?: string}>()
  const groupId = selectedWalletGroup?.groupId ?? null

  const [pasted, setPasted] = useState('')
  const [envelope, setEnvelope] = useState<TxEnvelope | null>(null)
  const [reviewed, setReviewed] = useState<ReviewedTransaction | null>(null)
  /**
   * The wallet `reviewed` was computed for.
   *
   * The IR is per *reader*: it decides which side is "YOUR WALLET" from the rail's own
   * account. So a review built for one wallet, shown while another is selected, labels
   * somebody else's money as yours — which is exactly what "switch and sign" produced,
   * because changing the selection makes a new signer available a beat before the review
   * has been rebuilt for them. Signing waits for the two to agree.
   *
   * Stamped from **`rail.dataRef.groupId`, not the selected group**. Those are the same
   * thing only once the rail has caught up, and the whole failure is the window where they
   * are not: `hydrate` closes over both, so recording the selection would mark a review
   * computed against the old wallet's rail as belonging to the new one — which is what the
   * first version of this gate did, and it changed nothing.
   */
  const [reviewedFor, setReviewedFor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** The shared wallet this envelope belongs to — absent for a foreign import. */
  const [shared, setShared] = useState<SharedWallet | null>(null)
  /**
   * That wallet's own rail, which is the one holding the UTxOs this transaction
   * spends. The selected wallet's rail holds none of them, so every co-signer
   * reviewing from their own wallet read the inputs as a stranger's and the
   * change as money arriving.
   */
  const [sharedRail, setSharedRail] = useState<CardanoRail | null>(null)
  const rail = sharedRail ?? selectedRail
  /** Open when the user must choose whose signature to give. */
  const [signAsOpen, setSignAsOpen] = useState(false)
  /**
   * Inputs the chain says are already spent.
   *
   * A gathering transaction holds no lock on anyone's coins, so a party can spend theirs
   * elsewhere while the others are still signing — and then no signature can rescue it. Read
   * once at hydrate: without it the screen offers to sign, the signing paths resolve to
   * nothing because the wallet no longer holds those UTxOs, and the failure surfaces as
   * "this file does not say which keys it needs" — which is not the reason and not
   * actionable. Observed on a draft whose inputs a later transaction had spent.
   */
  const [chainState, setChainState] = useState<EnvelopeChainState>({kind: 'open'})
  /** Kept as a count so the existing "coins were spent elsewhere" copy reads unchanged. */
  const spentInputs = chainState.kind === 'superseded' ? chainState.spentInputs : 0

  /**
   * We were sent to a specific transaction and the registry does not have it.
   *
   * Distinct from "no transaction yet", which is what the import form is for.
   * A link to a transaction that has been submitted, dismissed, or belongs to
   * another wallet used to land on that form — inviting someone to paste in a
   * transaction the app had just finished with, when the truthful answer is that
   * there is nothing here.
   */
  const [notFound, setNotFound] = useState(false)
  /**
   * How far the arrive-by-id path has got.
   *
   * Explicit, rather than inferred from which of `envelope` / `reviewed` happen to be set.
   * Inferring it was wrong in a way that only showed for a frame: `hydrate` sets the
   * envelope and leaves the review `null` when the rail is not up yet, and everything below
   * that is not a *complete* hydration falls through to the import form — so resuming
   * straight after a wallet switch, while the rail rebuilt, flashed "paste a transaction"
   * at someone who had just tapped a specific one.
   *
   * Three states rather than two nullables, because "still working" and "finished without a
   * review" need different screens and a nullable pair cannot tell them apart: reading it as
   * still-working spins for ever on a device with no configured rail.
   */
  const [hydration, setHydration] = useState<'loading' | 'done'>(pendingId === undefined ? 'done' : 'loading')
  const resuming = pendingId !== undefined && hydration === 'loading' && !notFound
  /**
   * Hydrated, but there is no review to show — `hydrate` produces none without a rail.
   *
   * Its own state because the honest answer is that this device cannot render the
   * transaction, which is neither "nothing here" nor an invitation to paste one.
   */
  const cannotReview = pendingId !== undefined && hydration === 'done' && envelope !== null && reviewed === null
  /**
   * The user asked for the import form from the nothing-here screen.
   *
   * Without it that screen would be a dead end for the one case it cannot rule out:
   * the transaction is real, it just never reached this device's registry.
   */
  const [importing, setImporting] = useState(false)

  // Everyone on the roster this device holds a key for — the set the "sign as"
  // choice is made from, and the reason it is a choice at all.
  const localCoSigners = useLocalCoSigners(shared, envelope?.signers ?? [])
  /**
   * The multiparty lookup, which is a different lookup — see
   * `useLocalMultipartySigners`. Run unconditionally so it stays above the branch, and
   * consulted only for a multiparty envelope; a multisig roster names CIP-1854 co-signers
   * whose key hashes no ordinary wallet holds, so it costs a match that cannot happen.
   */
  const isMultiparty = envelope?.kind === 'multiparty'
  /**
   * The review on screen was built for a different wallet than the one about to sign.
   *
   * **Multiparty only, and compared against the *selected* group.** Each party reviews
   * against their own rail, so for them "whose review is this" and "who is signing" must be
   * the same wallet. Multisig is the opposite by construction: every co-signer reviews the
   * *shared* wallet's rail while signing as their own, so the same comparison would block
   * all of them.
   *
   * Comparing `reviewedFor` against the rail instead does not work, however obvious it
   * looks: the rail and the review go stale together — `hydrate` closes over both — so in
   * the window after a selection change they agree with each other and disagree with the
   * signer. That version passed a live test while changing nothing.
   */
  const staleReview = isMultiparty && reviewedFor !== groupId
  const status = envelope !== null ? statusOf(envelope, requiredFor(envelope)) : null
  const localMultiparty = useLocalMultipartySigners(isMultiparty ? (envelope?.signers ?? []) : [])
  const outstandingMultiparty = outstandingMultipartySigners(localMultiparty)
  /**
   * The rows this device still owes, in whichever shape this envelope uses.
   *
   * Multiparty is narrowed to the *selected* wallet: the signing paths come from
   * `rail`, which is the selected wallet's, so offering to sign as a different local
   * wallet would resolve paths against the wrong UTxO set and produce a witness for
   * nothing. `switchToSign` below names the wallet to switch to instead.
   */
  const outstanding: readonly LocalCoSigner[] = isMultiparty
    ? outstandingMultiparty
        .filter((s) => s.groupId === groupId)
        // **One entry per wallet, not per owed witness.** A party whose selected coins sit
        // on two of their own addresses owes a witness per key and so appears on the roster
        // twice, which is correct there. Here it would offer the same wallet twice in the
        // "sign as" sheet for a choice that is not one: `resolveSigningPaths` reads the body
        // against this rail and returns a path for *every* input this wallet owns, so one
        // pass produces both witnesses.
        .filter((s, i, list) => list.findIndex((o) => o.groupId === s.groupId) === i)
        // Presented in the co-signer shape so the "sign as" sheet and the ceremony stay
        // one code path. `required` is 1 and `signed` is 0 by construction: this is one
        // signing action, and a wallet with nothing left to sign is not outstanding.
        .map((s) => ({
          tag: s.signerId,
          coSignerName: s.signerName,
          groupId: s.groupId,
          walletName: s.walletName,
          walletSource: s.source,
          signed: 0,
          required: 1,
        }))
    : outstandingLocalCoSigners(localCoSigners, status?.meetsQuorum === true)
  const signAs = outstanding[0] ?? null
  /** A local wallet that owes a signature but is not the one selected. */
  const switchToSign = isMultiparty ? (outstandingMultiparty.find((s) => s.groupId !== groupId) ?? null) : null
  const waitingOn = shared === null ? [] : awaitingCoSigners(shared, localCoSigners, envelope?.signers ?? [])

  /**
   * Review the envelope body against the wallet's own UTxOs.
   *
   * The spendable set is offered whole and `reviewCardanoTx` keeps the entries the
   * body actually spends, so one path serves both cases: an envelope this device
   * built resolves its inputs, and a *foreign* one matches nothing and reads
   * exactly as it did before — inputs unresolved, with the warning that says so.
   *
   * Passing `[]` unconditionally was the bug. It is right for the foreign side and
   * wrong for our own, and this is the last screen before a signature goes out: a
   * multi-index spend of 78.18 tADA showed "YOUR WALLET +1.647834" — its change,
   * with every input read as a stranger's.
   *
   * The rail is the shared wallet's own when the transaction belongs to one of
   * ours, and the selected wallet's otherwise — right for an envelope from
   * another tool, where nothing resolves and the warning says so.
   */
  const hydrate = useCallback(
    async (env: TxEnvelope) => {
      if (groupId === null) return
      setBusy(true)
      // Re-entered whenever the rail changes identity, so the state goes back to loading:
      // otherwise the gap between a rail-less first pass and the real one renders as a
      // settled "cannot be reviewed".
      setHydration('loading')
      try {
        const params = rail ? await Effect.runPromise(rail.protocolParams) : undefined
        const resolvedInputs =
          rail === null
            ? []
            : await Effect.runPromise(
                Effect.flatMap(rail.spendableUtxos, (utxos) => resolvedInputsFromSpendable(utxos)).pipe(
                  // An unreadable address must not cost the whole review: the
                  // amounts are still worth showing, and the unresolved-inputs
                  // warning is what says they may be incomplete.
                  Effect.orElseSucceed(() => [] as readonly ResolvedInput[]),
                  // The wallet's own coins answer for its own inputs and nothing else, which
                  // is every input of an ordinary send and *one party's* of a co-signed one.
                  // The rest are read off the chain, so the other parties' returns stop
                  // reading as money arriving from nowhere. See `foreign-inputs`.
                  Effect.flatMap((own) => resolveInputsWithChain(rail, env.bodyHex, own)),
                  Effect.provideService(Decode, rail.decode),
                ),
              )
        const ir =
          rail && params
            ? await Effect.runPromise(
                reviewCardanoTx(
                  env.bodyHex,
                  rail.account.walletContext,
                  resolvedInputs,
                  params,
                  undefined,
                  undefined,
                  env.auxHex,
                ).pipe(Effect.provide(cardanoDecodeLayer)),
              )
            : null
        setEnvelope(env)
        setReviewed(ir)
        setReviewedFor(ir === null ? null : (rail?.dataRef.groupId ?? null))
        const chain: EnvelopeChainState =
          rail === null
            ? {kind: 'open'}
            : await Effect.runPromise(
                envelopeChainState(rail, env.bodyHex).pipe(Effect.provideService(Decode, rail.decode)),
              )
        setChainState(chain)
        // A transaction of ours that is already on chain is finished, not pending. Dropping
        // the record here is what stops every co-signer who did not submit from keeping a
        // pending review of a completed send for ever — only the submitting device cleared
        // its own, and nothing told the others.
        if (chain.kind === 'landed') {
          logger.info('Co-sign envelope is already on chain; clearing it from the inbox', {
            origin: 'CoSign',
            txHash: chain.txHash,
          })
          void Effect.runPromise(Effect.ignore(platformForgetCosign(env)))
        }
      } catch (e: unknown) {
        logger.warn('Co-sign envelope could not be hydrated', {origin: 'CoSign', error: String(e)})
        showToast({variant: 'error', message: t('cosign.parseError')})
      } finally {
        setBusy(false)
        setHydration('done')
      }
    },
    [groupId, rail, t, showToast],
  )

  /**
   * Take in whatever a co-signer was sent: our own envelope, a cardano-cli
   * transaction file, or a lone witness file.
   *
   * One input for all three, because which format arrived is the sender's tool's
   * business and not something the person pasting it should have to know.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: `coSign` is stable per envelope and re-running on it would re-open a review the user just cancelled.
  useEffect(() => {
    if (pendingId === undefined || envelope === null || reviewed === null || busy) return
    // Not for a transaction the chain has already made unsubmittable: opening the review
    // asks for a signature that cannot be produced, so it only toasts the refusal.
    if (signAs === null || spentInputs > 0 || autoOpenedEnvelopes.has(pendingId)) return
    // The review must describe the wallet about to sign — see `reviewedFor`.
    if (staleReview) return
    autoOpenedEnvelopes.add(pendingId)
    void coSign(signAs)
  }, [pendingId, envelope, reviewed, signAs, busy, spentInputs, staleReview])

  const load = useCallback(
    async (json: string) => {
      if (groupId === null) return
      const incoming = classifyIncoming(json)
      let env: TxEnvelope
      // Both interop paths need the codec, and the rail is where it comes from.
      if (incoming !== null && rail === null) {
        showToast({variant: 'error', message: t('cardanoActivity.unavailable')})
        return
      }
      try {
        if (incoming?.kind === 'text-envelope-witness' && rail !== null) {
          // A witness alone means nothing without the transaction it signs.
          if (envelope === null) {
            showToast({variant: 'error', message: t('cosign.witnessWithoutTx')})
            return
          }
          env = await Effect.runPromise(addWitnessTextEnvelope(envelope, incoming.cborHex))
        } else if (incoming?.kind === 'text-envelope-tx' && rail !== null) {
          /**
           * The addresses this transaction's inputs sit on, read off the chain.
           *
           * Needed only for a **scriptless** transaction, which is a co-funded one from
           * another tool: its signers are the payment credentials behind its inputs, and a
           * body carries outpoints rather than addresses. A multisig file names its keys in
           * its own script and ignores this.
           *
           * Best-effort — a failure here leaves the import exactly as refusing as it was.
           */
          const inputAddressHexes = await Effect.runPromise(
            Inspect.txBodyFromTx(incoming.cborHex).pipe(
              Effect.flatMap((bodyHex) => resolveInputsWithChain(rail, bodyHex, [])),
              Effect.map((inputs) => inputs.map((i) => i.addressHex)),
              Effect.orElseSucceed(() => [] as readonly string[]),
              Effect.provideService(Decode, rail.decode),
            ),
          )
          env = await Effect.runPromise(
            envelopeFromTxTextEnvelope({
              cborHex: incoming.cborHex,
              chainId: cardanoChainId(rail.config.network),
              createdBy: t('cosign.importedFromFile'),
              createdAt: new Date().toISOString(),
              inputAddressHexes,
            }),
          )
        } else {
          env = await Effect.runPromise(parseEnvelope(json))
        }
      } catch (e: unknown) {
        // One message covers a malformed file, an envelope for another network and a CBOR body
        // we cannot decode — the user is told to try another file for all three.
        logger.warn('Co-sign envelope could not be parsed', {origin: 'CoSign', error: String(e)})
        showToast({variant: 'error', message: t('cosign.parseError')})
        return
      }
      await hydrate(env)
      // Track the imported envelope so it survives a restart / shows in the inbox.
      void Effect.runPromise(Effect.ignore(platformPersistCosign(groupId, env)))
    },
    [groupId, envelope, rail, hydrate, showToast, t],
  )

  // Resume-by-id: hydrate directly from the persisted registry, skipping import.
  useEffect(() => {
    if (pendingId === undefined || groupId === null) return
    let active = true
    void Effect.runPromise(platformCosignRegistry().get(pendingId))
      .then(async (p) => {
        if (!active) return
        if (p === null) {
          setNotFound(true)
          setHydration('done')
          return
        }
        // The shared wallet this envelope belongs to, and its rail. Resolved
        // before the review so the amounts are read against the UTxOs the
        // transaction actually spends; a failure here is not fatal, it just
        // leaves the review as unresolved as it was before.
        const resolved = await resolveSharedWalletRail(p.groupId, Date.now()).catch((e) => {
          logger.warn('Shared wallet rail did not resolve; the review stays unresolved', {
            origin: 'CoSignScreen',
            groupId: p.groupId,
            error: String(e),
          })
          return null
        })
        if (!active) return
        if (resolved !== null) {
          setShared(resolved.wallet)
          setSharedRail(resolved.rail)
        }
        void hydrate(p.envelope)
      })
      .catch((e) => {
        logger.warn('Resume-by-id hydration failed', {origin: 'CoSignScreen', pendingId, error: String(e)})
      })
    return () => {
      active = false
    }
  }, [pendingId, groupId, hydrate])

  const importFile = useCallback(async () => {
    const res = await DocumentPicker.getDocumentAsync({type: '*/*', copyToCacheDirectory: true, multiple: false})
    const asset = res.canceled ? null : res.assets[0]
    if (!asset) return
    const json = await new File(asset.uri).text()
    await load(json)
  }, [load])

  /**
   * What happens once this signer's witness exists: merge it into the envelope,
   * then either submit (quorum met) or keep it tracked and hand it off.
   *
   * Deliberately separate from the review: the screen owns producing the
   * signature, this owns what the signature is *for*. Splitting them is what lets
   * co-sign use the ordinary review funnel with no bespoke confirm mode.
   */
  /**
   * Broadcast an envelope whose quorum is met, and make the wallet act like it.
   *
   * Reached two ways: a signature that completed the quorum, and an envelope
   * that already met it when this screen opened — which is the ordinary case for
   * a wallet that needs only its own signature, and for the last co-signer
   * returning to a gathered transaction.
   */
  const submitGathered = useCallback(
    async (rail: CardanoRail, signed: TxEnvelope) => {
      const txHash = await Effect.runPromise(submitEnvelope(rail, signed))
      void Effect.runPromise(Effect.ignore(platformForgetCosign(signed)))
      // Lock the spent inputs and show the transaction in Activity. Without the
      // first, the wallet keeps offering coins it has already spent and the next
      // send is rejected as a double spend with nothing saying why; without the
      // second there is no evidence on screen that anything happened until the
      // indexer catches up.
      const submittedAt = Date.now()
      await Effect.runPromise(
        consumedUtxoIdsOf(signed.bodyHex).pipe(
          Effect.provideService(Decode, rail.decode),
          Effect.flatMap((consumedUtxoIds) =>
            rail.pendingTracker.register({txHash, consumedUtxoIds, change: [], submittedAt}),
          ),
          Effect.catchAll((e) => {
            logger.warn('Co-signed tx submitted but not tracked', {origin: 'CoSign', message: e.message})
            return Effect.void
          }),
        ),
      )
      // Only when the body was reviewable here — an envelope we could not render
      // has no IR to show in Activity, and inventing one would put a transaction
      // on screen described by nothing.
      if (reviewed !== null) registerPendingActivity(rail, txHash, reviewed, submittedAt)
      showToast({variant: 'success', message: t('cosign.submitted')})
      // Wallets, because that is where the pending row is. Staying here left the
      // co-sign screen describing a transaction it had just finished with, which
      // is what made a completed submit look like nothing had happened.
      // Route type isn't inferred for the new group yet; narrow cast per CLAUDE.md.
      router.dismissTo('/wallets' as never)
    },
    [reviewed, t, showToast, router],
  )

  /** Write a file to the cache and hand it to the share sheet. */
  const shareFile = useCallback(async (fileName: string, contents: string) => {
    const file = new File(Paths.cache, fileName)
    file.create({overwrite: true, intermediates: true})
    file.write(contents)
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(file.uri, {mimeType: 'application/json', UTI: 'public.json', dialogTitle: fileName})
    } else {
      await Share.share({message: contents})
    }
  }, [])

  /**
   * Hand the envelope to the composer and go pick a conversation.
   *
   * Registered rather than put in the route: a `TxEnvelope` is kilobytes, and the
   * thread reads it back by id. Nothing is sent from here — the user still picks
   * the co-signer and presses send with the message in front of them.
   */
  const askInDm = useCallback(() => {
    if (envelope === null) return
    const id = registerComposerDraft(serializeEnvelope(envelope))
    router.push(`/community?draft=${id}` as never)
  }, [envelope, router])

  /**
   * The envelope on the clipboard, for a co-signer reached outside this app.
   *
   * The same bytes {@link askInDm} would put in a message, so a co-signer who
   * receives it by any other route pastes it into the box on this screen and lands
   * in the same place. It is deliberately *not* a link and cannot become one — the
   * body, the scripts and every witness so far are kilobytes.
   *
   * Kept beside the DM path rather than replacing it: inside the app the envelope
   * arrives as a card with the ceremony one tap away, and a co-signer who has to
   * find the paste box is a co-signer who might not.
   */
  const copyTransaction = useCallback(() => {
    if (envelope === null) return
    void copy({text: serializeEnvelope(envelope), feedback: t('cosign.copied')})
  }, [envelope, copy, t])

  /**
   * Export the transaction in the format every other Cardano tool reads.
   *
   * Our own envelope carries the roster and who has signed, which is what makes
   * the inbox and the quorum panel possible — and which nothing outside this app
   * understands. This is the same transaction, stripped to what cardano-cli, a
   * hardware tool or another wallet can act on.
   */
  const exportForOtherTools = useCallback(async () => {
    if (envelope === null || rail === null) return
    setBusy(true)
    try {
      const text = await Effect.runPromise(toTxTextEnvelope(envelope))
      await shareFile(`tx-${envelope.createdAt.replace(/[:.]/g, '-')}.tx`, serializeTextEnvelope(text))
      showToast({variant: 'success', message: t('cosign.exported')})
    } catch (e: unknown) {
      logger.warn('Co-sign envelope could not be exported for other tools', {origin: 'CoSign', error: String(e)})
      showToast({variant: 'error', message: t('cosign.signError')})
    } finally {
      setBusy(false)
    }
  }, [envelope, rail, shareFile, showToast, t])

  const afterCoSign = useCallback(
    async (unsigned: TxEnvelope, witnessSetHex: string) => {
      if (groupId === null) return
      let signed: TxEnvelope
      try {
        const witnesses = await Effect.runPromise(envelopeWitnessesFrom(witnessSetHex))
        signed = witnesses.reduce<TxEnvelope>((env, w) => addSignature(env, w), unsigned)
        setEnvelope(signed)
        // Always tracked, whether or not this signature completed the quorum.
        void Effect.runPromise(Effect.ignore(platformPersistCosign(groupId, signed)))
      } catch (error) {
        // Logged, because this is the branch that genuinely lost a signature and a toast
        // is not evidence. The export branch below used to share this catch and this
        // message, so a share sheet that refused reported the signature as failed — after
        // it had already been merged and filed. The only visible difference between
        // "sign again" and "nothing to do" was a roster tick.
        logger.error('Co-sign failed to merge a witness', {origin: 'CoSign', error: String(error)})
        showToast({variant: 'error', message: t('cosign.signError')})
        return
      }

      // **Signing does not submit.** Broadcasting is the one irreversible step
      // here and it now waits for its own press. It used to happen as a side
      // effect of the last signature, which left this screen drawing a Submit
      // button — and an Ask and an Export — for a transaction already on its way
      // to the chain, with nothing saying so.
      if (statusOf(signed, requiredFor(signed)).meetsQuorum) return
      try {
        await shareFile(`cardano-tx-${signed.createdAt.replace(/[:.]/g, '-')}.json`, serializeEnvelope(signed))
        showToast({variant: 'success', message: t('cosign.exported')})
      } catch (error) {
        logger.warn('Co-signed tx saved but could not be exported', {origin: 'CoSign', error: String(error)})
        showToast({variant: 'error', message: t('cosign.exportFailed')})
      }
    },
    [groupId, shareFile, t, showToast],
  )

  /**
   * Submit an envelope that already met its quorum before this screen opened.
   *
   * Asking for a signature here would be theatre: the transaction is complete,
   * and a second witness from the same key changes nothing about whether it can
   * be broadcast.
   */
  const submitNow = useCallback(async () => {
    if (envelope === null || rail === null) return
    setBusy(true)
    try {
      await submitGathered(rail, envelope)
    } catch (error) {
      // The node says why, and it is worth repeating. A gathered transaction can
      // be refused for reasons no signature fixes — its inputs already spent by
      // an earlier transaction is the common one — and the generic "could not
      // sign" both misnames the step and hides the only sentence that explains
      // what to do next.
      const reason = ceremonyFailureReason(error)
      logger.warn('Co-signed tx submit failed', {origin: 'CoSign', reason})
      showToast({
        variant: 'error',
        message: reason === null ? t('cosign.submitFailed') : t('cosign.submitFailedReason', {reason}),
      })
    } finally {
      setBusy(false)
    }
  }, [envelope, rail, submitGathered, showToast, t])

  /**
   * Become the wallet that owes the next signature, without leaving the transaction.
   *
   * Multiparty signing needs the *signing party's* rail, because that party's inputs live in
   * their own wallet — which is why this screen can only offer the selected wallet's
   * signature and has to name the other one. Told rather than done, that was four steps
   * through the wallet switcher and back, and the switcher lands on Wallets rather than
   * here, so the transaction had to be found again. It is a supported case, not a rare one:
   * several wallets of your own, co-funding one transaction to pay one fee.
   *
   * The rail rebuilds on the selection change and the screen re-hydrates itself, so nothing
   * needs re-navigating.
   */
  const switchAndSign = useCallback(async () => {
    if (switchToSign === null) return
    setBusy(true)
    try {
      // Re-arm the auto-open. The guard was set when the review opened for the *previous*
      // wallet, and landing on the review as the new one is the whole point of the button.
      if (pendingId !== undefined) autoOpenedEnvelopes.delete(pendingId)
      await selectWallet(switchToSign.groupId)
    } catch (error) {
      logger.error('Failed to switch wallet to sign', {
        origin: 'CoSignScreen',
        groupId: switchToSign.groupId,
        error: String(error),
      })
      showToast({variant: 'error', message: t('walletDetail.toast.setActiveFailed', {name: switchToSign.walletName})})
    } finally {
      setBusy(false)
    }
  }, [switchToSign, pendingId, selectWallet, showToast, t])

  /** Stop tracking a transaction the chain has made unsubmittable. */
  const dismissDead = useCallback(async () => {
    if (envelope === null) return
    setBusy(true)
    try {
      await Effect.runPromise(Effect.ignore(platformForgetCosign(envelope)))
      router.dismissTo('/wallet/pending' as never)
    } finally {
      setBusy(false)
    }
  }, [envelope, router])

  const coSign = useCallback(
    async (as?: LocalCoSigner) => {
      if (envelope === null || groupId === null || reviewed === null) return
      // Never sign against a review that describes a different wallet — see `reviewedFor`.
      if (staleReview) return
      setBusy(true)
      try {
        if (rail === null) {
          showToast({variant: 'error', message: t('cardanoActivity.unavailable')})
          return
        }
        // The shared signing layer, not a bespoke one. The version built here had
        // to answer "what signs this?" itself, and answered `software` for
        // everything that was not hardware — which for a shared wallet sends the
        // ceremony looking for a seed that does not exist. `useCardanoSigningLayer`
        // answers for the group it is *asked* about, which is the co-signer's own.
        // As the chosen co-signer, not as whichever wallet happens to be selected.
        // `partialSignRequest` below names their group and derives their paths, so
        // the layer must not redirect it at somebody else's.
        const signer = as ?? signAs
        if (signer === null) {
          showToast({variant: 'error', message: t('cosign.noLocalCoSigner')})
          return
        }
        const signingLayer = await resolveSigningLayer(rail, groupId, {
          groupId: signer.groupId,
          source: signer.walletSource,
        })
        if (signingLayer === null) {
          showToast({variant: 'error', message: t('cosign.signError')})
          return
        }
        // Signing happens on the review screen, not here (Phase 16 item 41). It needs
        // no special mode: `partialSignRequest` is an ordinary `signOnly` request, so
        // the screen signs exactly the bytes it rendered and hands back this signer's
        // witness set. Only what happens *after* the signature — merge, quorum,
        // submit-or-export — is co-sign's business, and that stays here.
        // One path per payment index the transaction spends. `null` means the file
        // never said which indexes these are — an imported bare transaction — and a
        // guess there produces a witness for a key the script does not name, which
        // fails to count toward the quorum with nothing saying why.
        /**
         * The paths this signer signs with.
         *
         * **Multiparty derives them from the body, multisig from the envelope.** A
         * multisig envelope records the payment indexes the script spends at, and a guess
         * there produces a witness the script does not name. A multiparty envelope records
         * none — its signers are separate wallets, and each resolves its own inputs the
         * way an ordinary send does. `resolveSigningPaths` reads the body against this
         * rail's spendable set and returns paths only for the inputs this wallet owns,
         * which is exactly this party's share.
         */
        let signingPaths: readonly string[]
        if (isMultiparty) {
          const resolved = await Effect.runPromise(
            Effect.either(
              createCardanoTxContext(rail).resolveSigningPaths(envelope.bodyHex, signer.groupId, envelope.accountIndex),
            ),
          )
          if (resolved._tag === 'Left' || resolved.right.signingPaths.length === 0) {
            // No path means none of this body's inputs are ours to witness. Two different
            // causes, and `cosign.noDerivation` — "this file does not say which keys it
            // needs, ask the sender for the wallet transaction" — describes neither and
            // sends the user somewhere useless. Either this wallet's share has already been
            // spent elsewhere, or the roster matched a key this rail cannot sign for.
            const owned = resolved._tag === 'Right'
            logger.error('multiparty signing paths unresolved', {
              origin: 'CoSignScreen',
              reason: owned ? 'no owned inputs' : resolved.left.reason,
              spentInputs,
            })
            showToast({
              variant: 'error',
              message:
                spentInputs > 0
                  ? t('cosign.inputsSpent', {count: spentInputs})
                  : owned
                    ? t('cosign.noOwnedInputs')
                    : t('cosign.noDerivation'),
            })
            return
          }
          signingPaths = resolved.right.signingPaths
        } else {
          const indexes = keyIndexesOf(envelope)
          if (indexes === null) {
            showToast({variant: 'error', message: t('cosign.noDerivation')})
            return
          }
          // One path per script, at the role that script guards. A delegation is
          // authorised by the co-signers' *stake* keys (CIP-1854 role 2), so signing it
          // with a payment key produces a witness the script does not name — one that
          // counts toward nothing and says nothing.
          signingPaths = indexes.map((keyIndex, scriptIndex) =>
            scriptRoleAt(envelope, scriptIndex) === 'stake'
              ? ownStakePath(envelope.accountIndex)
              : ownPaymentPath(envelope.accountIndex, keyIndex),
          )
        }
        const ticketId = registerReviewTicket({
          legs: [
            {
              reviewed,
              request: partialSignRequest(envelope, signer.groupId, signingPaths),
            },
          ],
          groupId,
          audit: {purpose: 'cosign', origin: null},
          signingLayer,
          titleKey: 'cosign.title',
          signatureStatus: statusOf(envelope, requiredFor(envelope)),
          signerName: signer.coSignerName,
          // Stays put: co-signing continues on this screen once the witness is added.
          doneHref: null,
          onSettled: (results) => {
            const result = results.length === 1 ? results[0] : undefined
            if (result?._tag !== 'TxSignedOnly') {
              showToast({variant: 'error', message: t('cosign.signError')})
              return
            }
            void afterCoSign(envelope, result.witnessSetHex)
          },
          onError: () => showToast({variant: 'error', message: t('cosign.signError')}),
          onCancel: () => {},
        })
        router.push(`/wallet/review-tx?ticket=${ticketId}` as never)
      } catch (e: unknown) {
        logger.warn('Co-sign could not be routed to review', {origin: 'CoSign', error: String(e)})
        showToast({variant: 'error', message: t('cosign.signError')})
      } finally {
        setBusy(false)
      }
    },
    [
      envelope,
      reviewed,
      groupId,
      rail,
      signAs,
      isMultiparty,
      spentInputs,
      staleReview,
      resolveSigningLayer,
      t,
      showToast,
      router,
      afterCoSign,
    ],
  )

  if (envelope !== null && reviewed !== null) {
    return (
      <SafeAreaViewWrapper
        edges={['bottom']}
        scrollable
        contentContainerStyle={styles.content}
        stickyFooter={
          <StickyFooter>
            {/*
              Three states, and the middle one used to be missing. Quorum met:
              submit. A signature of ours still owed: sign it, saying whose it is.
              Neither: every key this device holds is already in the witness set,
              so "Review & sign" would re-sign with a key that is there and dedupe
              to nothing — a primary button that does nothing, which is how a
              gathered transaction read as broken.
            */}
            {chainState.kind === 'landed' ? (
              // It succeeded. Not a failure to explain and not a transaction to rebuild —
              // the only thing left is to stop showing it as pending, which hydrate has
              // already done.
              <>
                <Typography variant="bodySm_regular" style={styles.waiting} testID="cosign-already-submitted">
                  {t('cosign.alreadySubmitted')}
                </Typography>
                <Button
                  label={t('pending.dismiss')}
                  variant="secondary"
                  onPress={() => void dismissDead()}
                  fullWidth
                  isLoading={busy}
                  testID="cosign-dismiss-landed"
                />
              </>
            ) : spentInputs > 0 ? (
              // Nothing to sign and nothing to submit: the coins this transaction spends are
              // gone. Offered as a way out rather than a button that fails, because the only
              // remaining action is to stop tracking it.
              <>
                <Typography variant="bodySm_regular" style={styles.waiting} testID="cosign-inputs-spent">
                  {t('cosign.inputsSpent', {count: spentInputs})}
                </Typography>
                <Button
                  label={t('pending.dismiss')}
                  variant="secondary"
                  onPress={() => void dismissDead()}
                  fullWidth
                  isLoading={busy}
                  testID="cosign-dismiss-dead"
                />
              </>
            ) : status?.meetsQuorum === true ? (
              <Button
                label={t('cosign.submit')}
                onPress={submitNow}
                fullWidth
                size="xl"
                isLoading={busy}
                testID="cosign-action"
              />
            ) : signAs !== null ? (
              <Button
                // With one candidate the button names them and signs: a sheet
                // offering a single choice is a tap that asks nothing. With
                // several it opens the sheet, because the same button on the same
                // screen produces a different person's signature.
                label={
                  outstanding.length > 1
                    ? t('cosign.reviewAndSign')
                    : t('cosign.signAsName', {name: signAs.coSignerName})
                }
                onPress={outstanding.length > 1 ? () => setSignAsOpen(true) : () => void coSign()}
                fullWidth
                size="xl"
                isLoading={busy}
                testID="cosign-action"
              />
            ) : switchToSign !== null ? (
              // A local wallet owes a signature and it is not the selected one. The paths
              // come from the selected wallet's rail, so signing *as it stands* would
              // resolve against the wrong UTxO set — so the button changes which wallet
              // this is, rather than pretending the current one can sign.
              <Button
                label={t('cosign.switchAndSign', {wallet: switchToSign.walletName})}
                onPress={() => void switchAndSign()}
                fullWidth
                size="xl"
                isLoading={busy}
                testID="cosign-switch-wallet"
              />
            ) : (
              <Typography variant="bodySm_regular" style={styles.waiting} testID="cosign-waiting">
                {waitingOn.length > 0
                  ? t('cosign.waitingOn', {names: waitingOn.join(', ')})
                  : t('cosign.waitingGeneric')}
              </Typography>
            )}
            {/*
              Only while signatures are still owed. Past the quorum there is
              nobody to ask and nothing to export *for* — and a witness beyond the
              quorum is not merely redundant: the fee was sized for exactly that
              many, so one more makes the transaction underpay and be rejected.
            */}
            {status?.meetsQuorum === true || spentInputs > 0 ? null : (
              <>
                <Button
                  // Ask a co-signer over a DM. The envelope goes in the message body,
                  // not a link: it carries the transaction, its scripts and every
                  // witness so far, which no URI or QR can hold. Picking who to ask
                  // happens next, in the inbox — sending is a separate decision from
                  // deciding to send.
                  label={t('cosign.askInDm')}
                  variant="secondary"
                  onPress={askInDm}
                  fullWidth
                  isDisabled={busy || envelope === null}
                  testID="cosign-ask-dm"
                />
                <Button
                  // The envelope on the clipboard, for a co-signer you reach
                  // somewhere this app does not: another messenger, email, a shared
                  // note. The same bytes the DM would carry — kilobytes of JSON, not
                  // a link, because a transaction plus its scripts plus every
                  // witness fits in no URI. They paste it into this screen's box.
                  label={t('cosign.copyTransaction')}
                  variant="secondary"
                  onPress={copyTransaction}
                  fullWidth
                  isDisabled={busy || envelope === null}
                  testID="cosign-copy-transaction"
                />
                <Button
                  // The same transaction in the format every other Cardano tool
                  // reads, for a co-signer who is not using this app.
                  label={t('cosign.exportForTools')}
                  variant="secondary"
                  onPress={exportForOtherTools}
                  fullWidth
                  isDisabled={busy}
                  testID="cosign-export-cli"
                />
              </>
            )}
          </StickyFooter>
        }
      >
        {/*
          Deliberately not a review. The full review lives on the one screen that
          takes a signature for it; drawing it here too meant reading the same
          transaction twice to sign it once — the tabs, the amounts and the
          warnings, identically, on two screens in a row.

          What is left is what this screen is for: who still owes a signature.
        */}
        <Typography variant="bodySm_regular" style={styles.signAsLabel}>
          {t('cosign.rosterLabel')}
        </Typography>
        {rosterByCoSigner(status?.signers ?? []).map((entry) => {
          const complete = entry.owed > 0 && entry.signed >= entry.owed
          return (
            <View key={entry.id} style={styles.rosterRow}>
              <Typography variant="bodyMd_medium" style={styles.rosterName}>
                {entry.name}
              </Typography>
              {complete ? (
                <UniIcon name="check" size="sm" uniProps={(theme) => ({color: theme.colors.successDefault})} />
              ) : (
                <Typography variant="bodySm_regular" style={styles.signAsLabel}>
                  {t('txReview.signatures.rOfT', {signed: entry.signed, required: entry.owed})}
                </Typography>
              )}
            </View>
          )
        })}
        <SignAsSheet
          visible={signAsOpen}
          onClose={() => setSignAsOpen(false)}
          coSigners={localCoSigners}
          onPick={(picked) => void coSign(picked)}
        />
      </SafeAreaViewWrapper>
    )
  }

  // Arriving with a `pendingId` means a transaction is being fetched and reviewed —
  // `hydrate` waits on protocol params and the wallet's UTxOs, which is a network
  // round trip. Falling through to the import form meanwhile said the opposite of
  // what was happening: "there is nothing here, paste something". The card that led
  // here had just promised a transaction.
  if (resuming) {
    return (
      <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.centred}>
        <View style={styles.loading} testID="cosign-loading">
          <ActivityIndicator />
          <Typography variant="bodyMd_regular" style={styles.waiting}>
            {t('cosign.loading')}
          </Typography>
        </View>
      </SafeAreaViewWrapper>
    )
  }

  /**
   * Sent to a transaction that is not here.
   *
   * An answer, not a form, and it used to be rendered as one — a one-line notice
   * above a paste box, so a dead link looked like an invitation to type. What the
   * user wanted was a transaction; the useful next step is the list of the ones that
   * do exist, which is the anchored action. Importing stays reachable and stays
   * secondary, because arriving by a link and deliberately importing a file are two
   * different intentions and the screen now says which one it thinks you have.
   */
  if (notFound && !importing) {
    return (
      <SafeAreaViewWrapper
        edges={['bottom']}
        contentContainerStyle={styles.centred}
        stickyFooter={
          <StickyFooter>
            <Button
              label={t('cosign.seePending')}
              onPress={() => router.replace('/wallet/pending' as never)}
              fullWidth
              testID="cosign-see-pending"
            />
            <Button
              label={t('cosign.importInstead')}
              variant="secondary"
              onPress={() => setImporting(true)}
              fullWidth
              testID="cosign-import-instead"
            />
          </StickyFooter>
        }
      >
        <EmptyState
          icon="fileText"
          title={t('cosign.notFoundTitle')}
          description={t('cosign.notFound')}
          testID="cosign-not-found"
        />
      </SafeAreaViewWrapper>
    )
  }

  /**
   * The transaction is here and this device cannot render it — no Cardano rail.
   *
   * Its own screen because the alternative is the import form, which asks someone who
   * tapped a specific transaction to go and find one. "Nothing here" is also wrong: the
   * transaction exists, the wallet just cannot reach a chain to describe it.
   */
  if (cannotReview && !importing) {
    return (
      <SafeAreaViewWrapper
        edges={['bottom']}
        contentContainerStyle={styles.centred}
        stickyFooter={
          <StickyFooter>
            <Button
              label={t('cosign.seePending')}
              onPress={() => router.replace('/wallet/pending' as never)}
              fullWidth
              testID="cosign-see-pending"
            />
          </StickyFooter>
        }
      >
        <EmptyState
          icon="fileText"
          title={t('cosign.title')}
          description={t('cardanoActivity.unavailable')}
          testID="cosign-unavailable"
        />
      </SafeAreaViewWrapper>
    )
  }

  // Importing on purpose: from a file, or pasted from wherever a co-signer sent it.
  // The action is anchored rather than sitting under the box, so it does not move as
  // the paste grows and is never below the fold on a small screen.
  return (
    <SafeAreaViewWrapper
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.content}
      stickyFooter={
        <StickyFooter>
          <Button
            label={t('cosign.import')}
            onPress={() => load(pasted)}
            isLoading={busy}
            isDisabled={busy || pasted.trim().length === 0}
            fullWidth
            testID="cosign-import-submit"
          />
        </StickyFooter>
      }
    >
      <Typography variant="bodySm_regular" style={styles.waiting} testID="cosign-import-intro">
        {t('cosign.importBody')}
      </Typography>
      <Button
        label={t('cosign.importFile')}
        variant="secondary"
        onPress={importFile}
        isDisabled={busy}
        fullWidth
        testID="cosign-import-file"
      />
      <View style={styles.field}>
        <Typography variant="bodySm_medium" style={styles.fieldLabel}>
          {t('cosign.paste')}
        </Typography>
        <TextArea value={pasted} onChange={setPasted} autoCapitalize="none" autoCorrect={false} testID="cosign-paste" />
      </View>
    </SafeAreaViewWrapper>
  )
}
