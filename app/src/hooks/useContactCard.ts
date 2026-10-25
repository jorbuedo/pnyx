/**
 * This identity's contact card — what is on it, and saving a new version.
 *
 * Reads through the same row lookup everything else uses, so the card and the name come from one state
 * read rather than two. Saving needs the witness, so it gathers that per action exactly as
 * {@link module:./useHandleActions} does — held in state it would outlive the session that authorised it.
 *
 * ⚠️ **`occupiedSlots` is read, never inferred.** A save has to clear the rows a shrinking card leaves
 * behind, and how many there are is a property of what is *on chain*, not of what is being written. It
 * comes from the same read as the entries, and a save after a failed read is refused rather than guessed.
 *
 * @module
 */

import {type CardEntry, type CardRowBytes, cardWritePlan} from '@pnyx/contract-client/card'
import {identityCommitmentOf, identitySkFromForumRoot} from '@pnyx/contract-client/identity'
import {useCallback, useEffect, useState} from 'react'
import {logger} from '../logger'
import {useI18n, usePnyxSession} from '../providers'
import {saveCard} from '../services/identity-card'
import {identityContractAddressFor} from '../services/identity-contract'
import {resolveIdentityRow} from '../services/identity-row'
import {useToast} from './useToast'

const ORIGIN = 'useContactCard'

/** An hour, absolute — the intent's expiry, not a duration (a bare 3600 writes 1970). */
const ttl = (): number => Math.floor(Date.now() / 1000) + 3600

export type ContactCardState = {
  /** `undefined` while the first read is in flight — distinct from a card with nothing on it. */
  readonly entries: readonly CardEntry[] | undefined
  /**
   * The card's rows as the chain holds them, or `undefined` when that is not known.
   *
   * Exposed because a save is a **diff** and so is its cost: editing one entry of four is one
   * transaction, and the editor states that figure before you press Save.
   */
  readonly current: readonly CardRowBytes[] | undefined
  /** True while a save is proving or relaying. */
  readonly busy: boolean
  /** Replace the card with `next`. Resolves when every batch has been accepted, or a toast explains why not. */
  readonly save: (next: readonly CardEntry[]) => Promise<void>
  readonly reload: () => Promise<void>
}

export const useContactCard = (): ContactCardState => {
  const {t} = useI18n()
  const {session, identity: persisted} = usePnyxSession()
  const {showToast} = useToast()
  const [entries, setEntries] = useState<readonly CardEntry[] | undefined>(undefined)
  const [current, setCurrent] = useState<readonly CardRowBytes[] | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const pnyxId = persisted?.pnyxId
  const reload = useCallback(async () => {
    if (pnyxId === undefined) return
    const lookup = await resolveIdentityRow(pnyxId)
    if (lookup.kind !== 'row') {
      // ⚠️ Not `[]`. "Nothing on the card" and "we could not read the card" are different facts, and
      // saving on top of the second would clear rows we never saw.
      logger.debug('no row to read a card from', {origin: ORIGIN, kind: lookup.kind})
      setEntries(undefined)
      setCurrent(undefined)
      return
    }
    setEntries(lookup.row.card.entries)
    setCurrent(lookup.row.cardRows)
  }, [pnyxId])

  useEffect(() => {
    void reload()
  }, [reload])

  /**
   * Poll until the chain holds what was asked for.
   *
   * The test is `cardWritePlan(onChain, wanted).length === 0` — the same function the save plans with, so
   * "has it landed" cannot drift from "what would I write". Anything else would be a second comparison
   * to keep in step.
   *
   * Gives up rather than spinning: a transaction the chain later refuses must not leave the UI insisting
   * it worked. Returns whether it settled, and leaves state at whatever the last read said either way.
   */
  const waitForCard = useCallback(
    async (wanted: readonly CardEntry[]): Promise<boolean> => {
      if (pnyxId === undefined) return false
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        const lookup = await resolveIdentityRow(pnyxId)
        if (lookup.kind === 'row') {
          setEntries(lookup.row.card.entries)
          setCurrent(lookup.row.cardRows)
          if (cardWritePlan(lookup.row.cardRows, wanted).length === 0) return true
        }
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }
      logger.warn('the card save was accepted but the chain has not caught up', {origin: ORIGIN})
      await reload()
      return false
    },
    [pnyxId, reload],
  )

  const save = useCallback(
    async (next: readonly CardEntry[]) => {
      const root = session?.forumRoot
      if (root === undefined || session === undefined || current === undefined) {
        logger.warn('card save skipped: no session, or the current card was never read', {
          origin: ORIGIN,
          hasSession: session !== undefined,
          knowsRows: current !== undefined,
        })
        // Which one it is decides what the user can do about it, so the message says which.
        showToast({
          message: t(
            session === undefined || root === undefined ? 'you.card.saveNoSession' : 'you.card.saveUnavailable',
          ),
          variant: 'error',
        })
        return
      }
      const identitySk = identitySkFromForumRoot(root)
      const contractAddress = await identityContractAddressFor(identityCommitmentOf(identitySk)).catch(
        (error: unknown) => {
          logger.warn('card save has no identity contract address', {origin: ORIGIN, error: String(error)})
          return undefined
        },
      )
      if (contractAddress === undefined) {
        showToast({message: t('you.card.saveUnavailable'), variant: 'error'})
        return
      }

      setBusy(true)
      const result = await saveCard({
        entries: next,
        current,
        identitySk,
        contractAddress,
        networkId: session.network,
        expiresAtSecs: ttl(),
      })
      if (!result.ok) {
        setBusy(false)
        showToast({message: t(failureKey(result.failure.kind)), variant: 'error'})
        // ⚠️ Re-read either way. A save is several transactions and a mid-way failure leaves the card
        // partly written, so what is on screen after one is whatever the chain says — not what was asked
        // for, and not what was there before.
        await reload()
        return
      }
      // ⚠️ **Accepted is not landed.** The relay answers when the sponsor has taken the transaction, and
      // the chain confirms it seconds later — a single re-read here returns the *old* state and the new
      // entry silently never appears. Measured: the save logged at 14:12:47 and the block confirmed at
      // 14:12:50. The handle claim already learned this (`useHandleActions`'s `waitForRow`); the card
      // needed the same and did not have it.
      const landed = await waitForCard(next)
      setBusy(false)
      showToast(landed ? {message: t('you.card.saved')} : {message: t('you.card.savePending'), variant: 'error'})
    },
    [session, current, reload, showToast, t, waitForCard],
  )

  return {entries, current, busy, save, reload}
}

type CardFailureKey =
  | 'you.card.saveTooLarge'
  | 'you.card.saveUnreadable'
  | 'you.card.saveProofFailed'
  | 'you.card.saveRelayFailed'

/**
 * Exhaustive: a `default` arm here would report an unrecognised failure as a retryable one, and only
 * two of the four are.
 */
const failureKey = (kind: 'too-large' | 'unreadable' | 'proof' | 'relay'): CardFailureKey => {
  switch (kind) {
    case 'too-large':
      return 'you.card.saveTooLarge'
    case 'unreadable':
      return 'you.card.saveUnreadable'
    case 'proof':
      return 'you.card.saveProofFailed'
    case 'relay':
      return 'you.card.saveRelayFailed'
    default: {
      const unhandled: never = kind
      return unhandled
    }
  }
}
