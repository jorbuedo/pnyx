/**
 * What the notification centre should hold for direct messages.
 *
 * ⚠️ **The push itself cannot say who sent it.** Its payload carries no conversation id and no
 * sender, on purpose: it travels through FCM, and naming the conversation would hand the
 * who-talks-to-whom graph to Google. So a DM that arrives while the app is closed lands as an
 * identical, unactionable "New message" row every time — three of them tell you nothing three times.
 *
 * The device knows what the wire may not. Once the app is running it has the conversation list, the
 * peer and its handle, so the generic rows are replaced by one row per unread conversation, named
 * locally. Nothing extra is sent anywhere to make that possible.
 *
 * ⚠️ **The message text stays out.** The plaintext exists on this device, but only inside the sealed
 * `@pnyx/dm/thread/*` records; the notification store is written in the clear, so copying a message
 * into it would quietly undo that. The row names the sender and stops there.
 *
 * @module
 */

/** A conversation with something unread in it, as the inbox knows it. */
export type UnreadConversation = {
  readonly convId: string
  /** Display name for the peer — a handle when one resolved, otherwise a shortened id. */
  readonly label: string
  /** ISO-8601; the row is re-dated when a newer message lands. */
  readonly lastMessageAt: string
}

/** The subset of a stored notification this planner reads. */
export type StoredRow = {
  readonly id: number
  readonly date: string
  readonly data: Record<string, unknown>
}

export type DmRowPlan = {
  /** Ids to delete: the generic push rows, and our rows whose conversation is no longer unread. */
  readonly remove: readonly number[]
  /** Rows to write, one per unread conversation. Already-correct rows are absent. */
  readonly upsert: readonly {
    readonly id: number
    readonly convId: string
    readonly date: string
    readonly label: string
  }[]
}

/** Did this row come from a DM push, i.e. is it one of the generic ones we replace? */
const isGenericDmRow = (row: StoredRow): boolean =>
  (row.data.kind === 'dm-message' || row.data.kind === 'dm-invite') && typeof row.data.dmConvId !== 'string'

/** Is this a row we wrote? */
const conversationOf = (row: StoredRow): string | undefined =>
  typeof row.data.dmConvId === 'string' ? row.data.dmConvId : undefined

/**
 * Reconcile the stored rows against what is actually unread.
 *
 * Idempotent: called with the same inputs twice, the second call plans nothing. That matters because
 * this runs on every unread recomputation — a signal, a socket open, a resume — and a plan that
 * always wrote something would rewrite the inbox several times a minute.
 */
export const planDmRows = (
  rows: readonly StoredRow[],
  unread: readonly UnreadConversation[],
  idFor: (convId: string) => number,
): DmRowPlan => {
  const wanted = new Map(unread.map((c) => [c.convId, c]))
  const remove: number[] = []
  const seen = new Map<string, StoredRow>()

  for (const row of rows) {
    if (isGenericDmRow(row)) {
      remove.push(row.id)
      continue
    }
    const convId = conversationOf(row)
    if (convId === undefined) continue
    if (!wanted.has(convId)) {
      // Read elsewhere, or the conversation is gone. The dot cleared; this must too.
      remove.push(row.id)
      continue
    }
    seen.set(convId, row)
  }

  const upsert: {id: number; convId: string; date: string; label: string}[] = []
  for (const conversation of unread) {
    const existing = seen.get(conversation.convId)
    // ⚠️ The label is compared as well as the date. A peer's handle resolves *after* the row is
    // first written — the lookup is a chain read — so on date alone the row would keep the
    // shortened id it was born with and never take the name.
    const current = typeof existing?.data.dmLabel === 'string' ? existing.data.dmLabel : undefined
    if (existing !== undefined && existing.date === conversation.lastMessageAt && current === conversation.label) {
      continue
    }
    upsert.push({
      id: idFor(conversation.convId),
      convId: conversation.convId,
      date: conversation.lastMessageAt,
      label: conversation.label,
    })
  }
  return {remove, upsert}
}
