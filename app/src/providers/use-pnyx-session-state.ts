/**
 * Pnyx session state machine — the logic behind {@link ./PnyxSessionProvider}.
 *
 * The session is bound to the dedicated identity wallet (see
 * services/identity-wallet.ts), NOT to the selected wallet group — switching
 * or deleting funds wallets never touches the auth session.
 *
 * Two ways in, one state path:
 *  - `signIn()` — decrypt the identity seed through the enclave vault (OS
 *    biometric prompt), then SIWM.
 *  - `signInWithMnemonic(mnemonic)` — the onboarding path: the identity seed
 *    is already in memory (just generated / entered), so SIWM runs with it
 *    directly and NO OS prompt fires.
 *
 * Kept free of JSX so the state handling is unit-testable with the repo's
 * React hook simulation (see use-pnyx-session-state.test.ts).
 *
 * @module
 */

import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {logger} from '../logger'
import {
  clearPnyxIdentity,
  type PnyxIdentity,
  readPnyxIdentitySync,
  writePnyxIdentity,
} from '../services/pnyx-identity-storage'
import {
  classifySignInError,
  forumRootFromMnemonic,
  type PnyxSession,
  refreshSessionToken,
  type SignInFailure,
  signInWithMidnight,
} from '../services/pnyx-session'
import {clearStoredSession, restoreSessionSync, writeStoredSession} from '../services/session-store'
import {refreshDelayMs} from '../services/session-token'

export type PnyxSessionState = {
  /** In-memory session (JWT + address + network); undefined until sign-in. */
  readonly session: PnyxSession | undefined
  /**
   * The identity's `forumRoot`, available from the moment the enclave unlock passes.
   *
   * ⚠️ **Deliberately not read off `session`.** It is `HKDF(seed, "pnyx:root")` — pure derivation,
   * whose only prerequisite is the vault — but it used to surface only if the *network* sign-in
   * succeeded, so purely local features that need it (notes to self, the DM at-rest key) inherited a
   * backend dependency they never had. Set before the handshake starts, and kept if it fails.
   */
  readonly forumRoot: Uint8Array | undefined
  /** Last-known {address, network} — survives cold starts for display purposes. */
  readonly identity: PnyxIdentity | undefined
  readonly isSigningIn: boolean
  readonly signInError: SignInFailure | undefined
  /** Runs the enclave-gated SIWM flow. Resolves undefined on failure (error state is set). */
  readonly signIn: () => Promise<PnyxSession | undefined>
  /**
   * SIWM sign-in with the identity mnemonic the caller already holds (end of
   * onboarding, before it leaves memory) — bypasses the enclave vault, so no
   * OS prompt. Failure is non-blocking (resolves undefined, error state is set).
   */
  readonly signInWithMnemonic: (mnemonic: string) => Promise<PnyxSession | undefined>
  /**
   * The unlock-ceremony variant, used by the lock screen. Runs the same
   * enclave-decrypt (the single OS biometric prompt) → SIWM path as
   * {@link signIn}, but reports whether the *enclave* leg passed
   * (`authPassed`) independently of the SIWM network leg — so the caller
   * can unlock the app even when the content service is unreachable. A
   * cancelled/failed biometric leaves `authPassed` false and the app locked.
   * `hadIdentity` is false when no identity seed
   * exists on this device — nothing to unlock against.
   */
  readonly signInForUnlock: () => Promise<{authPassed: boolean; hadIdentity: boolean}>
  /**
   * Replace the session token from the identity master already in memory — no enclave, no prompt.
   *
   * Scheduled automatically before the token lapses; exposed so a surface that meets a refusal anyway
   * (a realtime ticket, a socket) can recover in place instead of sending the user to sign in again.
   * Resolves to `undefined` when the refresh could not be made, which is the caller's cue to ask.
   */
  readonly refresh: () => Promise<PnyxSession | undefined>
  /**
   * Record an identity that exists locally but has not signed in yet.
   *
   * Onboarding establishes the seed before any network call, and every avatar surface reads
   * {@link identity} — so without this the app has no avatar until a JWT comes back, or none at all
   * if the service is unreachable. Writes storage *and* state together: persisting alone leaves this
   * hook's copy stale, which is precisely how the avatar stayed blank.
   */
  readonly recordIdentity: (next: PnyxIdentity) => Promise<void>
  readonly signOut: () => void
}

export type PnyxSessionDeps = {
  /**
   * Whether an identity seed is available to sign in with — the `pnyx-identity`
   * vault slot. Undefined while still being resolved.
   */
  readonly canSignIn: boolean | undefined
  /**
   * Decrypt the identity seed — fires the OS biometric prompt.
   *
   * ⚠️ **The identity slot only.** A wallet group's mnemonic is a different vault entry, so unlocking
   * does not hold one — which is why the DUST sync keys cannot be seeded from an unlock without a
   * second read of a different group's seed. See `services/midnight/sync-keys.ts`.
   */
  readonly decryptIdentityMnemonic: () => Promise<string>
}

export function usePnyxSessionState({canSignIn, decryptIdentityMnemonic}: PnyxSessionDeps): PnyxSessionState {
  // Seeded from disk: the token outlives the process now, so a cold start inside the restore window
  // carries on where it left off instead of showing a sign-in card for a session that is still good.
  // `./session-restore` decides what "still good" means; a restored session has no `forumRoot`.
  const [session, setSession] = useState<PnyxSession | undefined>(restoreSessionSync)
  const [forumRoot, setForumRoot] = useState<Uint8Array | undefined>(undefined)
  const [identity, setIdentity] = useState<PnyxIdentity | undefined>(readPnyxIdentitySync)
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [signInError, setSignInError] = useState<SignInFailure | undefined>(undefined)
  const inFlight = useRef(false)
  const refreshInFlight = useRef<Promise<PnyxSession | undefined> | undefined>(undefined)
  /**
   * The live session, for callbacks that must not be rebuilt when it changes.
   *
   * ⚠️ `refresh` closing over `session` would give it a new identity on every sign-in, and consumers
   * that list it as an effect dependency — serving does — would tear down and redial their socket for
   * a change they do not care about. Written through {@link applySession} rather than in an effect, so
   * a refresh firing between render and commit still reads the session that is actually current.
   */
  // Only the first render's value is kept, which is the restored one; `applySession` owns it after that.
  const sessionRef = useRef<PnyxSession | undefined>(session)

  /**
   * The single place a session changes, and therefore the single place it is persisted.
   *
   * Writing here rather than at each mint point is what keeps a *refreshed* token on disk too: the
   * stored copy is always the one in use, so a cold start restores the newest token this device has
   * held rather than the one it first signed in with.
   */
  const applySession = useCallback((next: PnyxSession | undefined) => {
    sessionRef.current = next
    setSession(next)
    if (next === undefined) void clearStoredSession()
    else void writeStoredSession(next)
  }, [])

  const runSignIn = useCallback(
    async (
      getMnemonic: () => Promise<string>,
      /**
       * Called the instant the enclave leg passes, before the network sign-in starts.
       *
       * ⚠️ This is what lets unlock stop waiting on a Cloudflare Worker. See `signInForUnlock`.
       */
      onUnlocked?: () => void,
    ): Promise<{session?: PnyxSession; failure?: SignInFailure; unlocked: boolean}> => {
      if (inFlight.current) {
        // ⚠️ Dropped, not queued. If the one already running then fails, this attempt simply never
        // happened — and the caller sees the same nothing either way.
        logger.debug('[PnyxSession] sign-in skipped: one is already running', {origin: 'PnyxSession'})
        return {unlocked: false}
      }
      inFlight.current = true
      setIsSigningIn(true)
      setSignInError(undefined)
      // Tracks whether the enclave already let us in, which is what the app-lock decision actually
      // turns on. Reported explicitly rather than inferred from the failure bucket — the inference
      // is what made an unrelated crash read as a denied biometric.
      let unlocked = false
      try {
        const mnemonic = await getMnemonic()
        unlocked = true
        // Before the network, and kept whatever the network does — see `forumRoot` on the state.
        const root = await forumRootFromMnemonic(mnemonic)
        setForumRoot(root)
        onUnlocked?.()
        const next = await signInWithMidnight(mnemonic, root)
        applySession(next)
        // ⚠️ Sign-in used to log only on failure, so a session that was minted and then lost looked
        // exactly like one that was never asked for — which is what made "card save skipped: no
        // session" undiagnosable from the log alone.
        logger.debug('[PnyxSession] signed in', {
          origin: 'PnyxSession',
          identity: next.identity,
          knowsLifetime: next.lifetime !== undefined,
        })
        const nextIdentity: PnyxIdentity = {pnyxId: next.identity, network: next.network}
        setIdentity(nextIdentity)
        void writePnyxIdentity(nextIdentity)
        return {session: next, unlocked}
      } catch (error) {
        // Nothing but the enclave decrypt can have failed before the mnemonic is in hand, so that
        // window is `wallet` by construction instead of by guessing at the error's shape.
        const failure = unlocked ? classifySignInError(error) : 'wallet'
        logger.warn('[PnyxSession] sign-in failed', {
          origin: 'PnyxSession',
          failure,
          unlocked,
          error: String(error),
          // Without this the cause of an unexpected throw is unrecoverable from the log — the
          // message alone sent a React Native dev-bundle TypeError on a hunt through node_modules.
          stack: error instanceof Error ? error.stack : undefined,
        })
        setSignInError(failure)
        return {failure, unlocked}
      } finally {
        inFlight.current = false
        setIsSigningIn(false)
      }
    },
    [applySession],
  )

  const signIn = useCallback(async (): Promise<PnyxSession | undefined> => {
    if (canSignIn !== true) {
      // ⚠️ The button is on screen whenever there is no session, so this is a tap that does nothing.
      // Silent, it is indistinguishable from a sign-in that ran and failed.
      logger.warn('[PnyxSession] sign-in asked for with no identity slot to sign in with', {
        origin: 'PnyxSession',
        canSignIn,
      })
      return undefined
    }
    return (await runSignIn(decryptIdentityMnemonic)).session
  }, [canSignIn, decryptIdentityMnemonic, runSignIn])

  const signInWithMnemonic = useCallback(
    async (mnemonic: string): Promise<PnyxSession | undefined> =>
      (await runSignIn(() => Promise.resolve(mnemonic))).session,
    [runSignIn],
  )

  /**
   * Unlock, which is the enclave leg and nothing else.
   *
   * ⚠️ **It must not await the network sign-in that follows, and it used to.** Unlocking fires one OS
   * prompt whose decrypt is the whole authorisation; the SIWM exchange after it is three calls to a
   * Cloudflare Worker. Awaiting those meant a Worker that accepted the connection and never answered
   * held the lock screen's spinner open indefinitely — no error, so nothing logged, and no way into a
   * wallet the person had already authenticated to. The module doc has always said a failed network leg
   * "does not block unlock"; the `await` was quietly deciding otherwise.
   *
   * So this resolves the moment the enclave passes and lets the exchange finish on its own. A session
   * that does not arrive is a state the app already supports — `SignInCard` is the retry.
   */
  const signInForUnlock = useCallback((): Promise<{authPassed: boolean; hadIdentity: boolean}> => {
    if (canSignIn !== true) {
      logger.debug('[PnyxSession] unlock has no identity slot yet, so no sign-in', {
        origin: 'PnyxSession',
        canSignIn,
      })
      return Promise.resolve({authPassed: false, hadIdentity: false})
    }
    return new Promise((resolve) => {
      let settled = false
      const settle = (authPassed: boolean) => {
        if (settled) return
        settled = true
        resolve({authPassed, hadIdentity: true})
      }
      // The enclave decrypt is the single unlock prompt, and `unlocked` reports it directly rather than
      // being inferred as "any failure other than `wallet`" — that inference made a derivation error
      // (which happens *after* the prompt passed) wrongly keep the app locked.
      void runSignIn(decryptIdentityMnemonic, () => settle(true)).then(({session: next, unlocked}) => {
        // Only reached before `settle(true)` when the enclave leg itself failed.
        settle(next !== undefined || unlocked)
      })
    })
  }, [canSignIn, decryptIdentityMnemonic, runSignIn])

  /**
   * Replace the token without an OS prompt, from the `forumRoot` the session already holds.
   *
   * Single-flight: the proactive timer and a 401 can want this at the same moment, and two refreshes
   * would spend two nonces to arrive at the same place. The second caller awaits the first.
   *
   * ⚠️ **Returns `undefined` rather than throwing, and does not touch `signInError`.** A refresh runs
   * with nobody looking at it; painting the sign-in card red for a failure the user never asked for
   * would report a recoverable lapse as a broken identity. The caller that *did* ask — serving, a
   * socket — decides what to show.
   */
  const refresh = useCallback(async (): Promise<PnyxSession | undefined> => {
    const current = sessionRef.current
    if (current === undefined) {
      // Ordinary — a 401 can arrive before the first sign-in — but it decides whether the caller
      // should be asking the user, so it is worth saying rather than inferring from a bare undefined.
      logger.debug('[PnyxSession] nothing to refresh: no session yet', {origin: 'PnyxSession'})
      return undefined
    }
    const already = refreshInFlight.current
    if (already !== undefined) return already
    logger.debug('[PnyxSession] refreshing the token', {origin: 'PnyxSession'})
    const attempt = refreshSessionToken(current)
      .then((next) => {
        applySession(next)
        return next
      })
      .catch((error: unknown) => {
        logger.warn('[PnyxSession] token refresh failed', {
          origin: 'PnyxSession',
          failure: classifySignInError(error),
          error: String(error),
        })
        return undefined
      })
      .finally(() => {
        refreshInFlight.current = undefined
      })
    refreshInFlight.current = attempt
    return attempt
  }, [applySession])

  // The three facts the refresh schedule turns on, kept as values so the effect below can depend on
  // them instead of on the session object. See its `biome-ignore`.
  const lifetime = session?.lifetime
  const hasSession = session !== undefined
  const canRefresh = session?.forumRoot !== undefined

  /**
   * Replace the token before it lapses, so nothing downstream ever meets a 401.
   *
   * ⚠️ **A delay, never a deadline.** `refreshDelayMs` is measured from the moment this token arrived,
   * using the token's own `exp - iat` — comparing `exp` to the device clock would make a phone whose
   * clock is an hour out either refresh in a loop or never refresh at all.
   *
   * A token that states no lifetime schedules nothing: the 401 path covers it, and guessing an hour
   * would be worse than not guessing.
   */
  // ⚠️ Depends on the three narrowed facts and never on `session` itself: the object changes identity
  // whenever anything about the session does, and that would re-arm this timer each time, restarting
  // the delay instead of leaving the schedule already running alone.
  useEffect(() => {
    // ⚠️ A restored session cannot be refreshed: `refreshSessionToken` signs with `authPriv`, derived
    // from the `forumRoot` that is deliberately not persisted. Scheduling one would spend the timer
    // on a throw. The bound on a restored token is its age instead (`services/session-restore`).
    if (hasSession && !canRefresh) {
      logger.debug('[PnyxSession] this session carries no forum root, so no refresh is scheduled', {
        origin: 'PnyxSession',
      })
      return
    }
    if (lifetime === undefined) {
      // ⚠️ The consequence is invisible: nothing is scheduled, so this session will lapse and whatever
      // uses it next meets a 401 instead of a fresh token. `readTokenLifetime` says *why* it could not
      // be read; this says what that costs.
      if (hasSession) {
        logger.debug('[PnyxSession] no token lifetime, so no proactive refresh is scheduled', {
          origin: 'PnyxSession',
        })
      }
      return
    }
    const delay = refreshDelayMs(lifetime)
    logger.debug('[PnyxSession] token refresh scheduled', {origin: 'PnyxSession', inSeconds: Math.round(delay / 1000)})
    const timer = setTimeout(() => {
      void refresh()
    }, delay)
    return () => clearTimeout(timer)
  }, [lifetime, hasSession, canRefresh, refresh])

  const recordIdentity = useCallback(async (next: PnyxIdentity) => {
    setIdentity(next)
    await writePnyxIdentity(next)
  }, [])

  const signOut = useCallback(() => {
    applySession(undefined)
    setIdentity(undefined)
    setSignInError(undefined)
    // Identity-scoped key material: it must not outlive the identity it belongs to.
    setForumRoot(undefined)
    void clearPnyxIdentity()
    void clearStoredSession()
  }, [applySession])

  return useMemo<PnyxSessionState>(
    () => ({
      session,
      forumRoot,
      identity,
      isSigningIn,
      signInError,
      signIn,
      signInWithMnemonic,
      signInForUnlock,
      refresh,
      recordIdentity,
      signOut,
    }),
    [
      session,
      forumRoot,
      identity,
      isSigningIn,
      signInError,
      signIn,
      signInWithMnemonic,
      signInForUnlock,
      refresh,
      recordIdentity,
      signOut,
    ],
  )
}
