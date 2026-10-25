import type {DisplayedNotification} from '@notifee/react-native'

import {
  idFromString,
  type PushEvent,
  TRANSACTION_SCREENS,
  Trigger,
  triggerForKind,
} from '../services/notification-types'

export function deriveSweptTrigger(data: Record<string, unknown>): Trigger {
  const byKind = triggerForKind(data)
  if (byKind !== undefined) return byKind
  if (typeof data.screen === 'string' && TRANSACTION_SCREENS.has(data.screen)) return Trigger.Transaction
  if (data.type === 'transaction') return Trigger.Transaction
  return Trigger.Push
}

/**
 * Which source the stable id was recovered from. Tracked so Sentry queries
 * can measure how often each fallback fires post-merge — a spike in
 * `data-transactionId` recoveries means FCM / Notifee is failing to attach
 * its native id on iOS, which is the next thing to investigate upstream.
 */
export type StableIdSource = 'remote-messageId' | 'notif-id' | 'displayed-id'

export type StableIdResult =
  | {readonly kind: 'ok'; readonly id: string; readonly source: StableIdSource}
  | {readonly kind: 'missing'}

export function resolveStableId(displayed: DisplayedNotification): StableIdResult {
  const remote = (displayed.notification as DisplayedNotification['notification'] & {remote?: {messageId?: string}})
    .remote
  if (remote && typeof remote.messageId === 'string' && remote.messageId.length > 0) {
    return {kind: 'ok', id: remote.messageId, source: 'remote-messageId'}
  }
  if (typeof displayed.notification.id === 'string' && displayed.notification.id.length > 0) {
    return {kind: 'ok', id: displayed.notification.id, source: 'notif-id'}
  }
  if (typeof displayed.id === 'string' && displayed.id.length > 0) {
    return {kind: 'ok', id: displayed.id, source: 'displayed-id'}
  }
  return {kind: 'missing'}
}

function parseDisplayedDateMs(rawDate: string): number | undefined {
  // Notifee native code sets `displayed.date` to `String(postTime)` — epoch
  // milliseconds (e.g. `'1630835976663'`). `Date.parse` returns NaN for that
  // format, which would skip every swept notification on iOS.
  if (/^\d+$/.test(rawDate)) {
    const ms = Number.parseInt(rawDate, 10)
    if (Number.isFinite(ms) && ms > 0) return ms
    return undefined
  }
  const ms = Date.parse(rawDate)
  if (Number.isFinite(ms) && ms > 0) return ms
  return undefined
}

export type DeliveryDateSource = 'notifee-date' | 'fcm-sent-time'

export type DeliveryDateResult =
  | {readonly kind: 'ok'; readonly date: string; readonly source: DeliveryDateSource}
  | {readonly kind: 'missing'}

export function resolveDeliveryDate(
  displayed: DisplayedNotification,
  data: Record<string, unknown>,
): DeliveryDateResult {
  const rawDate = displayed.date
  if (typeof rawDate === 'string' && rawDate.length > 0) {
    const ms = parseDisplayedDateMs(rawDate)
    if (ms != null) return {kind: 'ok', date: new Date(ms).toISOString(), source: 'notifee-date'}
  }
  const sentTime = data['google.sent_time']
  if (typeof sentTime === 'string' || typeof sentTime === 'number') {
    const ms = typeof sentTime === 'number' ? sentTime : Number.parseInt(sentTime, 10)
    if (Number.isFinite(ms) && ms > 0) return {kind: 'ok', date: new Date(ms).toISOString(), source: 'fcm-sent-time'}
  }
  return {kind: 'missing'}
}

export type EventDropReason = 'no-stable-id' | 'no-delivery-date'

export type EventFromDisplayedResult =
  | {
      readonly kind: 'ok'
      readonly event: PushEvent
      readonly idSource: StableIdSource
      readonly dateSource: DeliveryDateSource
    }
  | {readonly kind: 'dropped'; readonly reason: EventDropReason; readonly idSource: StableIdSource | null}

export function eventFromDisplayed(displayed: DisplayedNotification): EventFromDisplayedResult {
  const notif = displayed.notification
  const data = (notif.data ?? {}) as Record<string, unknown>
  const title = notif.title ?? ''
  const body = notif.body ?? ''

  const idResult = resolveStableId(displayed)
  if (idResult.kind === 'missing') {
    return {kind: 'dropped', reason: 'no-stable-id', idSource: null}
  }

  const dateResult = resolveDeliveryDate(displayed, data)
  if (dateResult.kind === 'missing') {
    return {kind: 'dropped', reason: 'no-delivery-date', idSource: idResult.source}
  }

  // Android's FCM service auto-displays "notification" pushes with id `'0'`
  // (every push shares the placeholder), so hashing the raw id would collapse
  // every Android background-displayed notif onto one inbox row. Fall back
  // to a date-hash for that sentinel case. Every other id (FCM messageIds
  // like "0:1730…%abc", and non-numeric strings in general) must use the id
  // directly — `Number(idStr)` truthy-
  // -check would erroneously route them all to the date fallback and break
  // dedup against the headless-handler-stored row.
  const isAutoDisplayPlaceholder = idResult.id === '0' || idResult.id.length === 0
  const id = isAutoDisplayPlaceholder ? idFromString(dateResult.date) : idFromString(idResult.id)

  return {
    kind: 'ok',
    event: {
      id,
      date: dateResult.date,
      isRead: false,
      title,
      body,
      data,
      trigger: deriveSweptTrigger(data),
    },
    idSource: idResult.source,
    dateSource: dateResult.source,
  }
}

export function sortDisplayedForImport(items: ReadonlyArray<DisplayedNotification>): DisplayedNotification[] {
  return [...items].sort((a, b) => {
    const aResult = eventFromDisplayed(a)
    const bResult = eventFromDisplayed(b)
    const aMs = aResult.kind === 'ok' ? new Date(aResult.event.date).getTime() : 0
    const bMs = bResult.kind === 'ok' ? new Date(bResult.event.date).getTime() : 0
    return aMs - bMs
  })
}
