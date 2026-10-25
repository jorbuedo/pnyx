/**
 * Runs one transaction through the on-device model and returns its explanation.
 *
 * The whole pipeline in one place: `ReviewedTransaction` → bounded, redacted facts
 * (`services/explain/facts`) → a framed prompt (`services/explain/prompt`) →
 * `@pnyx/model-native`. Each of those is pure and unit-tested; this hook only owns
 * the React state and the asset-name lookup.
 *
 * Failure is an ordinary outcome, never an exception a screen has to catch: the model
 * can refuse, run out of context, or be unavailable by the time the user taps. The
 * feature is an extra, so a failed explanation must degrade to a message rather than
 * break the transaction screen it sits on.
 *
 * @module
 */

import {CARDANO_MAINNET} from '@pnyx/config'
import {generate, generateStructured, getModelStatus} from '@pnyx/model-native'

declare const __DEV__: boolean

import type {ReviewedTransaction} from '@pnyx/tx-review'
import {Effect} from 'effect'
import {useCallback, useEffect, useMemo, useState} from 'react'
import {logger} from '../logger'
import {useWalletData, useWalletList} from '../providers'
import {summarizeCeremony} from '../screens/cardano/ceremony-summary'
import {isProgrammableTokenTx} from '../services/cardano/cip113/activity'
import {allCip113ScriptCredentials} from '../services/cardano/cip113/deployment-selection'
import {useTokenInfos} from '../services/cardano-assets/hooks'
import {type Contact, platformContactsStore} from '../services/contacts'
import type {KnownAddress} from '../services/explain/facts'
import {explainableCeremonyFactsOf, explainableFactsOf} from '../services/explain/facts'
import {buildExplainPrompt, safetyLinesOf} from '../services/explain/prompt'
import {sanitizeExplanation} from '../services/explain/sanitize'
import {composeStructuredExplanation, expectedDirectionOf, explainSchema} from '../services/explain/structured'
import {useNetworkCapabilities} from './useNetworkCapabilities'

export type ExplainState =
  | {readonly status: 'idle'}
  | {readonly status: 'running'}
  | {readonly status: 'ready'; readonly text: string}
  | {readonly status: 'failed'}

export type UseExplainTransaction = {
  readonly state: ExplainState
  readonly explain: () => void
  readonly reset: () => void
}

/** Asset ids the transaction moved, so their names can be resolved for the prompt. */
const assetIdsOf = (reviewed: ReviewedTransaction): readonly string[] => {
  const ids = new Set<string>()
  for (const party of reviewed.ownGroup.parties) {
    for (const amount of [...party.sent, ...party.received]) {
      if (amount.assetId !== undefined) ids.add(amount.assetId)
    }
  }
  return [...ids]
}

export type ExplainSubject = {
  /** Every transaction the confirm covers. One for history, one-or-more pre-sign. */
  readonly legs: readonly ReviewedTransaction[]
  /** Signatures over arbitrary payloads in the same ceremony; they move no funds. */
  readonly messageCount: number
  /** `pending` is the pre-sign review, where the model must not describe or reassure. */
  readonly when: 'settled' | 'pending'
  /**
   * What approving causes. Omitted for settled history, where it already happened.
   *
   * `willBroadcast` is false for `signOnly` requests — a dApp `signTx` or a multisig
   * partial sign returns a witness set rather than submitting.
   */
  readonly outcome?: {
    readonly willBroadcast: boolean
    readonly quorum?: {readonly signed: number; readonly required: number; readonly meetsQuorum: boolean}
  }
}

export const useExplainTransaction = (subject: ExplainSubject): UseExplainTransaction => {
  const {legs, messageCount, when, outcome} = subject
  // Facts and names key off the first leg; a ceremony's legs share a producer.
  const reviewed = legs[0]
  const [state, setState] = useState<ExplainState>({status: 'idle'})
  // tADA on the testnets. Hardcoding "ADA" made the first real run describe a preprod
  // transaction in mainnet units.
  const {adaTicker} = useNetworkCapabilities()

  // Names are author-controlled; `explainableFactsOf` quarantines them rather than
  // treating them as fact. Resolved here because this is the layer with the token
  // metadata — `facts.ts` stays pure and takes them as an argument.
  const assetIds = useMemo(() => (reviewed === undefined ? [] : assetIdsOf(reviewed)), [reviewed])
  // A CIP-113 transfer explains itself terribly without knowing what a programmable token is —
  // the IR can only say "contract execution". Detected from the shipped deployment's credentials,
  // which the reviewed transaction cannot carry.
  const isCip113 = useMemo(
    () =>
      reviewed !== undefined && isProgrammableTokenTx(reviewed, allCip113ScriptCredentials(reviewed.networkId ?? 0)),
    [reviewed],
  )
  const {infos} = useTokenInfos(assetIds)

  // The user's own address book, so a counterparty can be named rather than described
  // as "another address". These names are the user's, not a requester's, so they are
  // stated as fact rather than quarantined.
  const {walletGroups} = useWalletList()
  const {listAddressesForWallet} = useWalletData()
  const [known, setKnown] = useState<ReadonlyMap<string, KnownAddress>>(() => new Map())

  useEffect(() => {
    let active = true
    const build = async () => {
      const map = new Map<string, KnownAddress>()

      // The user's other wallets first. "Sent to another address" is technically true
      // and materially misleading when the address is their own.
      for (const group of walletGroups ?? []) {
        const rows = await listAddressesForWallet(group.groupId, CARDANO_MAINNET).catch((e) => {
          logger.warn('Address read failed; that wallet will not be recognised as one of their own', {
            origin: 'useExplainTransaction',
            groupId: group.groupId,
            error: String(e),
          })
          return []
        })
        for (const row of rows) map.set(row.human, {kind: 'own-wallet', label: group.name})
      }

      // `Effect.either` rather than a rejected runPromise: a FiberFailure would lose the
      // typed reason, and a missing address book must not break the explanation anyway.
      const contacts = await Effect.runPromise(Effect.either(platformContactsStore().list()))
      if (contacts._tag === 'Right') {
        // Contacts win: a name the user typed is more informative than a wallet name,
        // and if they saved their own address under a label they meant it.
        for (const c of contacts.right as readonly Contact[]) {
          map.set(c.addressBech32, {kind: 'contact', label: c.name})
        }
      }
      if (active) setKnown(map)
    }
    void build()
    return () => {
      active = false
    }
  }, [walletGroups, listAddressesForWallet])

  const explain = useCallback(() => {
    if (reviewed === undefined) {
      setState({status: 'failed'})
      return
    }
    setState({status: 'running'})
    // `label` is the metadata layer's own ticker→name→symbol resolution, always present.
    const names = new Map([...infos].map(([id, info]) => [id, info.label]))
    // A ceremony is explained as one thing — the aggregate the review screen already
    // renders — with the batch's own risks stated, rather than leg by leg.
    const multi = legs.length > 1
    const summary = multi ? summarizeCeremony(legs) : null
    const facts =
      summary === null
        ? explainableFactsOf(reviewed, names, known, {isCip113})
        : explainableCeremonyFactsOf({summary, first: reviewed, messageCount, names, known, isCip113}).overall
    const ceremony = {transactionCount: legs.length, messageCount, submittedInSequence: multi}
    const promptOptions = {
      ticker: adaTicker,
      when,
      ceremony,
      ...(outcome === undefined ? {} : {outcome}),
    }
    const started = Date.now()

    // Constrained decoding where the platform has it, plain text everywhere else. The
    // two paths share the same facts, so the only difference is whether the answer can
    // be checked before it is shown.
    // Captured for the dev logs below, which run after `run()` has picked a path and
    // must report the prompt that was actually sent rather than guess at one.
    let sentPrompt = ''
    const run = async (): Promise<string> => {
      const {supportsStructuredOutput} = await getModelStatus()
      if (!supportsStructuredOutput) {
        sentPrompt = buildExplainPrompt(facts, promptOptions)
        // Enforced here rather than asked for in the prompt: the model copied the
        // SAFETY: label into user-facing text with the rule against it present.
        return sanitizeExplanation(await generate(sentPrompt))
      }
      sentPrompt = buildExplainPrompt(facts, {...promptOptions, structured: true})
      const decoded = await generateStructured(sentPrompt, explainSchema())
      const composed = composeStructuredExplanation(decoded, {
        direction: expectedDirectionOf(facts),
        requiresSafety: safetyLinesOf(facts, ceremony).length > 0,
      })
      if (!composed.ok) {
        // Deliberately not retried and not fallen back: the check caught the model
        // contradicting the facts, and the plain-text path would reproduce it without
        // the check. Logged by reason so the rejection rate is measurable.
        logger.warn('tx explanation rejected', {origin: 'ExplainTransaction', reason: composed.reason})
        throw new Error(`structured explanation rejected: ${composed.reason}`)
      }
      if (composed.droppedUnfoundedSafety) {
        logger.warn('tx explanation invented a warning', {origin: 'ExplainTransaction'})
      }
      return composed.text
    }

    void run()
      .then((trimmed) => {
        logger.info('tx explanation generated', {
          origin: 'ExplainTransaction',
          ms: Date.now() - started,
          chars: trimmed.length,
          // Dev only. The text describes the user's own transaction, so it is diagnostic
          // data in a debug session and would be a privacy leak in shipped logging — the
          // same reason it never goes to Sentry. Without it a prompt can only be tuned
          // by asking the user to read the screen aloud.
          ...(__DEV__ ? {text: trimmed, prompt: sentPrompt} : {}),
        })
        // An empty completion is a failure, not an explanation: rendering a blank
        // sheet would read as "nothing to say about this transaction".
        setState(trimmed.length > 0 ? {status: 'ready', text: trimmed} : {status: 'failed'})
      })
      .catch((e: unknown) => {
        logger.warn('tx explanation failed', {
          origin: 'ExplainTransaction',
          ms: Date.now() - started,
          error: e instanceof Error ? e.message : String(e),
          // The input matters most on the failure path: a refusal or a context overflow
          // is a property of the prompt, and without it the cause is unguessable.
          ...(__DEV__ ? {prompt: sentPrompt} : {}),
        })
        setState({status: 'failed'})
      })
  }, [reviewed, legs, messageCount, when, outcome, infos, adaTicker, known, isCip113])

  const reset = useCallback(() => setState({status: 'idle'}), [])

  return {state, explain, reset}
}
