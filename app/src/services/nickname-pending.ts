/**
 * A nickname the user chose but whose row write has not landed yet.
 *
 * **Onboarding asks for a name and must not block on the chain to get one.** Choosing a nickname is
 * one `setPrimaryName`, and that write needs the identity shell deployed, the artifacts fetched and a
 * sponsored relay — none of which should stand between a new user and the app. So the name is
 * recorded here first, and {@link module:./nickname-flush} completes it when it can.
 *
 * ⚠️ **The intent is not the name.** The row is the only place a nickname actually lives; this is a
 * record of work still owed. It is cleared the moment the write lands, so a device holding one is
 * telling you the write has not landed — which is also the only way to tell that apart from a user
 * who skipped the step.
 *
 * ⚠️ Stored validated, and re-validated on read. A pending name written by an older build (or a
 * build whose charset rules differed) must not be replayed into the row: the rules decide what may be
 * *written*, and a value that no longer passes them is dropped rather than carried forward. Same
 * reasoning as the stored `pnyx_id` that outlived its format — a persisted value is validated against
 * the code that will use it, not against its JavaScript type.
 *
 * @module
 */

import {validateHandle} from '@pnyx/contract-client/handle'
import {logger} from '../logger'
import {storage} from '../platform/storage'

const PENDING_KEY = 'pnyx:nickname-pending'
const ORIGIN = 'nickname-pending'

/**
 * How many times a pending write may be attempted before it stops being retried automatically.
 *
 * ⚠️ A bound rather than forever, because a name the chain keeps refusing is not a transient
 * failure — and a flush runs on every foreground, so an unbounded retry is an unbounded sponsored
 * relay. The intent is *kept* when the bound is reached, not discarded: the user can still finish it
 * from the ID screen, and the record is what tells that screen there is something to finish.
 */
export const MAX_FLUSH_ATTEMPTS = 5

export type PendingNickname = {
  /** The display spelling, exactly as the user typed it. */
  readonly display: string
  /** Attempts so far. Compared against {@link MAX_FLUSH_ATTEMPTS}. */
  readonly attempts: number
}

const parse = (raw: string | null): PendingNickname | undefined => {
  if (raw === null) return undefined
  try {
    const value = JSON.parse(raw) as Partial<PendingNickname>
    if (typeof value.display !== 'string' || typeof value.attempts !== 'number') {
      logger.debug('the stored record is not a pending nickname', {origin: ORIGIN})
      return undefined
    }
    const checked = validateHandle(value.display)
    if (!checked.ok) {
      // Not an error the user caused and not one a retry fixes: this build will not write these bytes.
      logger.warn('a pending nickname is not writable by this build; dropping it', {
        origin: ORIGIN,
        reason: checked.reason,
      })
      return undefined
    }
    return {display: checked.display, attempts: value.attempts}
  } catch (error) {
    logger.warn('the pending nickname could not be parsed; dropping it', {origin: ORIGIN, error: String(error)})
    return undefined
  }
}

/** Synchronous read (MMKV), so a screen can tell during render that a name is still owed. */
export const readPendingNicknameSync = (): PendingNickname | undefined => parse(storage.getSync(PENDING_KEY))

export const readPendingNickname = async (): Promise<PendingNickname | undefined> =>
  parse(await storage.get(PENDING_KEY))

/**
 * Record a nickname as owed.
 *
 * @throws never — a failure to persist is logged and swallowed, because the caller is an onboarding
 * step that must continue regardless. What is lost is the retry, not the user's progress; they can
 * set the name again from the ID screen.
 */
export const writePendingNickname = async (display: string): Promise<void> => {
  const checked = validateHandle(display)
  if (!checked.ok) {
    // A caller that did not validate is a defect — the input screen validates as the user types.
    logger.warn('refusing to record an invalid nickname as pending', {origin: ORIGIN, reason: checked.reason})
    return
  }
  try {
    await storage.set(PENDING_KEY, JSON.stringify({display: checked.display, attempts: 0} satisfies PendingNickname))
    logger.info('a nickname is recorded as pending', {origin: ORIGIN, nickname: checked.display})
  } catch (error) {
    logger.warn('failed to record a pending nickname; it will not be retried', {
      origin: ORIGIN,
      error: String(error),
    })
  }
}

/** Note an attempt that did not land, so the bound can be reached. */
export const countPendingAttempt = async (pending: PendingNickname): Promise<void> => {
  const next = {display: pending.display, attempts: pending.attempts + 1} satisfies PendingNickname
  try {
    await storage.set(PENDING_KEY, JSON.stringify(next))
  } catch (error) {
    logger.warn('failed to record a nickname flush attempt', {origin: ORIGIN, error: String(error)})
  }
}

export const clearPendingNickname = async (): Promise<void> => {
  try {
    await storage.remove(PENDING_KEY)
    logger.debug('the pending nickname is cleared', {origin: ORIGIN})
  } catch (error) {
    logger.warn('failed to clear the pending nickname', {origin: ORIGIN, error: String(error)})
  }
}
