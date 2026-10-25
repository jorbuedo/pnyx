/**
 * The session token, across a cold start.
 *
 * ⚠️ **This reverses a decision that was deliberate, and the reason it was deliberate still holds.**
 * `./pnyx-identity-storage` used to say "never the content-service JWT: a token on disk would
 * outlive the enclave gate that produced it". It does outlive it, and that is the cost: reopening
 * the app no longer asks for a biometric, because the token it already has is enough. The bound is
 * `./session-restore` — a stored token is usable for half an hour and then thrown away, so what a
 * copy of this storage buys an attacker is at most the rest of that half hour.
 *
 * What is *not* stored is the part that would make it worse: `forumRoot` is seed-derived key
 * material and stays in memory only. A restored session can therefore talk to the service and
 * cannot sign anything new, which is also why it cannot refresh itself.
 *
 * Profile-scoped like every other key here, so the decoy profile restores the decoy's session and
 * never the real one.
 *
 * @module
 */

import {logger} from '../logger'
import {storage} from '../platform/storage'
import type {PnyxSession} from './pnyx-session'
import {restoreDecision} from './session-restore'
import {readTokenLifetime} from './session-token'

const SESSION_KEY = 'pnyx:session'
const ORIGIN = 'session-store'

type StoredSession = {
  readonly token: string
  readonly network: string
  /** The `pnyx_id` the token was issued to. */
  readonly identity: string
  /** Device clock, at the moment the token arrived. Compared only against this device's own clock. */
  readonly receivedAtMs: number
}

const parse = (raw: string | null): StoredSession | undefined => {
  if (raw === null) return undefined
  try {
    const value = JSON.parse(raw) as Partial<StoredSession>
    if (
      typeof value.token === 'string' &&
      typeof value.network === 'string' &&
      typeof value.identity === 'string' &&
      typeof value.receivedAtMs === 'number' &&
      Number.isFinite(value.receivedAtMs)
    ) {
      return {
        token: value.token,
        network: value.network,
        identity: value.identity,
        receivedAtMs: value.receivedAtMs,
      }
    }
    logger.debug('the stored session is not a session record', {origin: ORIGIN})
  } catch (error) {
    logger.warn('the stored session could not be parsed; treating as signed out', {
      origin: ORIGIN,
      error: String(error),
    })
  }
  return undefined
}

/**
 * The session this device last held, if it is still worth having.
 *
 * Synchronous so the provider can seed its initial state with it: a session that arrives one render
 * later shows the sign-in card first and then yanks it away, which reads as a flicker rather than as
 * a restore.
 *
 * ⚠️ The restored session carries **no `forumRoot`** — see the module note. Anything that needs one
 * (a refresh, forum proving) has to ask the enclave.
 */
export const restoreSessionSync = (now: () => number = Date.now): PnyxSession | undefined => {
  const stored = parse(storage.getSync(SESSION_KEY))
  if (stored === undefined) {
    logger.debug('no stored session to restore', {origin: ORIGIN})
    return undefined
  }
  const ageMs = now() - stored.receivedAtMs
  const lifetime = readTokenLifetime(stored.token)
  const decision = restoreDecision({ageMs, lifetime})
  logger.debug('a stored session was read', {
    origin: ORIGIN,
    decision,
    ageSeconds: Math.round(ageMs / 1000),
    knowsLifetime: lifetime !== undefined,
  })
  if (decision === 'discard') {
    void clearStoredSession()
    return undefined
  }
  return {
    token: stored.token,
    network: stored.network,
    identity: stored.identity,
    receivedAtMs: stored.receivedAtMs,
    ...(lifetime === undefined ? {} : {lifetime}),
  }
}

/** Keep the token for the next cold start. Called wherever a session is minted or replaced. */
export const writeStoredSession = async (session: PnyxSession): Promise<void> => {
  const record: StoredSession = {
    token: session.token,
    network: session.network,
    identity: session.identity,
    receivedAtMs: session.receivedAtMs,
  }
  try {
    await storage.set(SESSION_KEY, JSON.stringify(record))
  } catch (error) {
    // The session still works; only the next cold start is poorer for it. Worth a line, because
    // "the restore never happens" is otherwise diagnosed at the wrong end.
    logger.warn('the session could not be stored, so the next cold start will ask for a sign-in', {
      origin: ORIGIN,
      error: String(error),
    })
  }
}

/** Forget it. Signing out, and any stored session this build will not use. */
export const clearStoredSession = async (): Promise<void> => {
  try {
    await storage.remove(SESSION_KEY)
  } catch (error) {
    logger.warn('the stored session could not be cleared', {origin: ORIGIN, error: String(error)})
  }
}
