/**
 * This identity's name, and the two things you can do to it.
 *
 * One hook because the name is shown in one place (the identity card) and released in another (the
 * modal behind it), and both have to agree about whether a claim has landed. Two copies of this
 * state would drift the moment one of them refreshed.
 *
 * @module
 */

import {identityCommitmentOf, identitySkFromForumRoot} from '@pnyx/contract-client/identity'
import {useCallback, useEffect, useState} from 'react'
import {logger} from '../logger'
import {useI18n, usePnyxSession} from '../providers'
import {useWalletList} from '../providers/WalletProvider'
import {claimHandle, type HandleWriteFailure, releaseHandle, type UnavailableReason} from '../services/handle-claim'
import {claimAt, claimEnded, claimStarted} from '../services/handle-claim-progress'
import {claimSettled, releaseSettled} from '../services/handle-settled'
import {identityContractAddressFor} from '../services/identity-contract'
import {forgetPeerHandle, peerHandleFor, peerNicknameFor} from '../services/peer-label'
import {useToast} from './useToast'

const ORIGIN = 'useHandleActions'

/** An hour, absolute — the intent's expiry, not a duration (a bare 3600 writes 1970). */
const ttl = (): number => Math.floor(Date.now() / 1000) + 3600

type HandleFailureKey =
  | 'you.handle.invalid'
  | 'you.handle.proofFailed'
  | 'you.handle.relayFailed'
  | `you.handle.unavailable${'NoRegistry' | 'RegistryUnreachable' | 'WalletLocked' | 'TierNotFree' | 'Registering' | 'PermitPending' | 'Taken' | 'Reserved' | 'Internal' | 'NotOffered' | 'BoundNotShown'}`

/**
 * One key per reason, both levels exhaustive on purpose.
 *
 * A `default` arm here used to report every unrecognised failure as "relay failed" — telling the user
 * to retry something that had not been sent and could not succeed. The `never` assignments make a new
 * failure kind, or a new unavailable reason, a compile error instead of a wrong message. That matters
 * most for `unavailable`, where two of the reasons are retryable and the rest are not.
 */
const failureKey = (failure: HandleWriteFailure): HandleFailureKey => {
  switch (failure.kind) {
    case 'invalid':
      return 'you.handle.invalid'
    case 'proof':
      return 'you.handle.proofFailed'
    case 'relay':
      return 'you.handle.relayFailed'
    case 'unavailable':
      return unavailableKey(failure.reason)
    default: {
      const unhandled: never = failure
      return unhandled
    }
  }
}

const unavailableKey = (reason: UnavailableReason): HandleFailureKey => {
  switch (reason) {
    case 'no-registry':
      return 'you.handle.unavailableNoRegistry'
    case 'registry-unreachable':
      return 'you.handle.unavailableRegistryUnreachable'
    case 'wallet-locked':
      return 'you.handle.unavailableWalletLocked'
    case 'tier-not-free':
      return 'you.handle.unavailableTierNotFree'
    case 'registering':
      return 'you.handle.unavailableRegistering'
    case 'permit-pending':
      return 'you.handle.unavailablePermitPending'
    case 'taken':
      return 'you.handle.unavailableTaken'
    case 'reserved':
      return 'you.handle.unavailableReserved'
    case 'internal':
      return 'you.handle.unavailableInternal'
    case 'not-offered':
      return 'you.handle.unavailableNotOffered'
    case 'bound-not-shown':
      return 'you.handle.unavailableBoundNotShown'
    default: {
      const unhandled: never = reason
      return unhandled
    }
  }
}

export type HandleActions = {
  /** The **registered** name this identity's row holds, or `undefined` while no handle backs it. */
  readonly handle: string | undefined
  /**
   * The name the row shows, registered or not.
   *
   * ⚠️ This is what the ID screen draws. `handle` only says whether it may be written in handle
   * syntax — the two are the same bytes in the same field, and at launch (no deployed payment
   * contract) `handle` is always `undefined` while this is whatever the user chose.
   */
  readonly nickname: string | undefined
  readonly busy: boolean
  readonly claim: (name: string) => Promise<void>
  /** Re-read the held name from chain — for a screen coming back into view after another claimed. */
  readonly refresh: () => Promise<void>
  readonly release: () => Promise<void>
}

export const useHandleActions = (): HandleActions => {
  const {t} = useI18n()
  const {session, identity: persisted} = usePnyxSession()
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const {showToast} = useToast()
  const [handle, setHandle] = useState<string | undefined>(undefined)
  const [nickname, setNickname] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  // **Reading needs no session.** A name is public chain state, and the persisted identity outlives
  // the JWT — so the ID screen shows your name on a cold start, before you sign in, exactly as it
  // shows your id. Only claim and release need `session`, because only they need the witness.
  const identity = persisted?.pnyxId
  const refresh = useCallback(async () => {
    if (identity === undefined) return
    // A refresh that reads the memo is not a refresh: the answer is cached against contract heights
    // this call would not move, so it would return whatever the last one did.
    forgetPeerHandle(identity)
    // One shared read answers both: `resolvePeer` de-duplicates in flight.
    const [name, registered] = await Promise.all([peerNicknameFor(identity), peerHandleFor(identity)])
    setNickname(name)
    setHandle(registered)
  }, [identity])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /**
   * Wait for the row to actually say what we asked for.
   *
   * `/register` answers 202 when the **sponsor accepted** the transaction, not when it is on chain —
   * so a single re-read always loses the race and leaves the UI claiming nothing happened. Gives up
   * rather than spinning forever: a transaction the chain later refuses must not leave the UI
   * insisting it worked.
   */
  const waitForRow = useCallback(
    async (settled: (current: string | undefined) => boolean): Promise<boolean> => {
      if (identity === undefined) return false
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        // ⚠️ Forget first, every time. `peerHandleFor` is memoised, so a poll without this re-reads its
        // own first answer for the full two minutes and reports a landed write as a timeout.
        forgetPeerHandle(identity)
        const current = await peerHandleFor(identity)
        if (settled(current)) {
          setHandle(current)
          return true
        }
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }
      await refresh()
      return false
    },
    [identity, refresh],
  )

  /**
   * The witness, the contract and the wallet, gathered per action rather than held in state.
   *
   * ⚠️ The **wallet** half is new and not optional: a claim mints a permit to an address derived from
   * this account's seed and signs the spend with that key, so the group and account index have to be
   * named explicitly rather than pinned inside the service ([[accounts-must-be-explicit]]).
   */
  const inputsFor = useCallback(async () => {
    const root = session?.forumRoot
    if (root === undefined || session === undefined) return undefined
    const groupId = selectedWalletGroup?.groupId
    if (groupId === undefined) {
      logger.warn('handle action has no selected wallet group', {origin: ORIGIN})
      return undefined
    }
    const identitySk = identitySkFromForumRoot(root)
    // Derived from this identity's own `C`, not configured: one contract per identity.
    const address = await identityContractAddressFor(identityCommitmentOf(identitySk)).catch((error: unknown) => {
      logger.warn('handle action has no identity contract address', {origin: ORIGIN, error: String(error)})
      return undefined
    })
    if (address === undefined) return undefined
    return {
      identitySk,
      contractAddress: address,
      networkId: session.network,
      expiresAtSecs: ttl(),
      groupId,
      accountIndex: selectedAccountIndex,
      biometricPrompt: t('you.handle.biometricPrompt'),
    }
  }, [session, selectedWalletGroup?.groupId, selectedAccountIndex, t])

  const run = useCallback(
    async (action: 'claim' | 'release', name: string) => {
      const inputs = await inputsFor()
      if (inputs === undefined) {
        showToast({message: t('you.handle.unavailableWalletLocked'), variant: 'error'})
        return
      }
      setBusy(true)
      const claiming = action === 'claim'
      // Progress lives outside React so it survives leaving this screen — there are two instances of
      // this hook, and `busy` told neither of them anything the other could see.
      if (claiming) claimStarted(name)
      const result = claiming ? await claimHandle(name, true, inputs) : await releaseHandle(name, inputs)
      if (!result.ok) {
        setBusy(false)
        // The toast is the notification; the store is the record. After a hundred seconds of waiting
        // the reason has to still be there when the user looks up.
        if (claiming) claimEnded({kind: 'failed', reasonKey: failureKey(result.failure)})
        showToast({message: t(failureKey(result.failure)), variant: 'error'})
        return
      }
      // Accepted, not settled — say exactly that, then wait for the row to agree.
      if (claiming) claimAt('awaiting-row')
      showToast({message: t('you.handle.submitted')})
      // ⚠️ Folded, not lower-cased. The row holds the **display** spelling, so comparing it to the typed
      // name never settles — see `handle-settled.ts`.
      const landed = await waitForRow((current) => (claiming ? claimSettled(current, name) : releaseSettled(current)))
      setBusy(false)
      if (claiming) {
        claimEnded(landed ? {kind: 'claimed'} : {kind: 'failed', reasonKey: 'you.handle.pending'})
      }
      showToast(
        landed
          ? {message: claiming ? t('you.handle.claimed') : t('you.handle.released')}
          : {message: t('you.handle.pending'), variant: 'error'},
      )
    },
    [inputsFor, waitForRow, showToast, t],
  )

  const claim = useCallback(async (name: string) => run('claim', name), [run])
  const release = useCallback(async () => {
    if (handle === undefined) return
    await run('release', handle)
  }, [run, handle])

  // `refresh` is exposed because there are two copies of this hook — the ID tab and the claim screen —
  // and a claim on one leaves the other showing its mount-time answer. Whoever comes back into view
  // re-reads rather than trusting state a different instance moved.
  return {handle, nickname, busy, claim, release, refresh}
}
