/**
 * Deleting a conversation: what it removes, and why all of it has to go together.
 *
 * A conversation is four separate local things, written by four different code paths — the MLS
 * group state, the plaintext thread, the index row the inbox lists from, and the consent book entry
 * that remembers the permit it runs on. "Delete" is the only operation that has to remove every
 * one, and getting a *subset* is worse than doing nothing:
 *
 * - group state left behind → `startDmConversation` adopts it, so starting again silently returns
 *   the broken conversation you were trying to escape
 * - index row left behind → the inbox lists a conversation that can no longer be opened
 * - consent left behind → the next conversation with that peer inherits a mute
 *
 * ⚠️ **Local only, and one-sided.** Nothing here touches the service: the peer keeps their half of
 * the group until they delete too, and messages they already sent stay queued for us until they
 * expire. There is no "delete for both" and there cannot be one — the other device is theirs.
 *
 * ⚠️ **Every step runs even if an earlier one fails.** A partial delete is the state this module
 * exists to prevent, so a failure in one store must not skip the others; each is attempted, and the
 * outcome names what did not come off rather than throwing at the first problem.
 *
 * @module
 */

import {Effect} from 'effect'
import {logger} from '../logger'
import {forgetConversationConsent} from './dm-consent'
import {removeConversation} from './dm-conversation-index'
import {
  clearRepairPending,
  deriveDmStoreKey,
  forgetGroupState,
  forgetPriorGroupState,
  forgetThread,
  loadConversationIndex,
  saveConversationIndex,
} from './dm-session'

const ORIGIN = 'dm-delete'

/** Which parts of a conversation could not be removed. Empty means it is fully gone. */
export type DmDeleteOutcome = {
  readonly ok: boolean
  readonly failed: readonly ('group' | 'thread' | 'index' | 'consent')[]
}

/** Run one leg, reporting rather than throwing, so the legs after it still run. */
const attempt = async (part: 'group' | 'thread' | 'index' | 'consent', work: Promise<unknown>): Promise<boolean> => {
  try {
    await work
    return true
  } catch (error) {
    logger.warn('dm delete: one part of the conversation could not be removed', {
      origin: ORIGIN,
      part,
      error: String(error),
    })
    return false
  }
}

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect as Effect.Effect<A, never>)

/**
 * Remove every local trace of a conversation.
 *
 * The group state goes **first**: it is the one whose survival is actively harmful, because adoption
 * would hand it straight back on the next start.
 */
export const deleteDmConversation = async (forumRoot: Uint8Array, convId: string): Promise<DmDeleteOutcome> => {
  const failed: ('group' | 'thread' | 'index' | 'consent')[] = []

  if (!(await attempt('group', run(forgetGroupState(convId))))) failed.push('group')
  // The changeover copy and the tie-break marker are part of the group, not extras: a survivor of
  // either would make a fresh conversation behave as if it were still repairing an old one.
  if (!(await attempt('group', run(forgetPriorGroupState(convId))))) failed.push('group')
  if (!(await attempt('group', run(clearRepairPending(convId))))) failed.push('group')
  if (!(await attempt('thread', run(forgetThread(convId))))) failed.push('thread')

  const indexOk = await attempt(
    'index',
    (async () => {
      const storeKey = await run(deriveDmStoreKey(forumRoot))
      const current = await run(loadConversationIndex(storeKey))
      await run(saveConversationIndex(storeKey, removeConversation(current, convId)))
    })(),
  )
  if (!indexOk) failed.push('index')

  const consentOk = await attempt(
    'consent',
    (async () => {
      const storeKey = await run(deriveDmStoreKey(forumRoot))
      await run(forgetConversationConsent(storeKey, convId))
    })(),
  )
  if (!consentOk) failed.push('consent')

  // Logged on success too: a delete that quietly did nothing and a delete that worked must not read
  // the same way in a log, which is how the conversation that prompted this went undiagnosed.
  logger.info('dm conversation deleted', {origin: ORIGIN, convId, failed: failed.length, parts: failed})
  return {ok: failed.length === 0, failed}
}
