/**
 * Apply {@link module:./dm-notification-rows}'s plan to the notification centre.
 *
 * Split from the planner so the decision stays pure and testable, and from the hook so a React
 * render is not where storage writes live.
 *
 * @module
 */

import {logger} from '../logger'
import {planDmRows, type StoredRow, type UnreadConversation} from './dm-notification-rows'
import {pushNotificationManager} from './notification-manager'
import {idFromString, Trigger} from './notification-types'

const ORIGIN = 'dm-notification-sync'

/** Stable per conversation, so a second message updates the row rather than adding one. */
const idFor = (convId: string): number => idFromString(`dm:${convId}`)

export const syncDmNotificationRows = async (
  unread: readonly UnreadConversation[],
  title: (peer: string) => string,
  body: string,
): Promise<void> => {
  try {
    const config = await pushNotificationManager.config.read()
    const wanted = config[Trigger.DirectMessage].notify ? unread : []
    if (wanted !== unread) {
      // Switched off is not the same as "nothing arrived": reconciling against an empty set is what
      // clears rows written while it was on, and the unread dots in the DM inbox are untouched.
      logger.debug('dm notification rows suppressed by the user setting', {origin: ORIGIN, unread: unread.length})
    }
    const stored = await pushNotificationManager.events.read()
    const rows: StoredRow[] = stored.map((event) => ({id: event.id, date: event.date, data: event.data}))
    const plan = planDmRows(rows, wanted, idFor)
    if (plan.remove.length === 0 && plan.upsert.length === 0) {
      // Not silent: "nothing to reconcile" and "a row this planner does not recognise" look identical
      // from outside, and the second is a real failure mode — a push path that writes a shape the
      // planner cannot match leaves a row nothing will ever clear.
      logger.debug('dm notification rows already agree', {
        origin: ORIGIN,
        stored: rows.length,
        kinds: rows.map((row) => String(row.data.kind ?? 'none')).join(','),
      })
      return
    }

    for (const id of plan.remove) await pushNotificationManager.events.remove(id)
    for (const row of plan.upsert) {
      const conversation = wanted.find((c) => c.convId === row.convId)
      if (conversation === undefined) continue
      const existing = stored.find((event) => event.id === row.id)
      const next = {
        id: row.id,
        date: row.date,
        isRead: false,
        title: title(conversation.label),
        body,
        // `dmConvId` never leaves the device: it is what lets the next reconciliation recognise its
        // own rows, and what a tap could one day use to open the right thread.
        // `dmLabel` is stored so the next pass can tell a row that already names the peer from one
        // still showing the id it was written with before the handle resolved.
        data: {kind: 'dm-message', dmConvId: row.convId, dmLabel: row.label, screen: 'dm'},
        trigger: Trigger.DirectMessage,
      }
      if (existing === undefined) {
        await pushNotificationManager.events.push(next)
      } else {
        await pushNotificationManager.events.update(row.id, {
          date: next.date,
          title: next.title,
          data: next.data,
          isRead: false,
        })
      }
    }
    logger.debug('dm notification rows reconciled', {
      origin: ORIGIN,
      removed: plan.remove.length,
      written: plan.upsert.length,
    })
  } catch (error) {
    // The dots and the inbox are the primary surface; a failure here must not take them with it.
    logger.warn('could not reconcile the dm notification rows', {origin: ORIGIN, error: String(error)})
  }
}
