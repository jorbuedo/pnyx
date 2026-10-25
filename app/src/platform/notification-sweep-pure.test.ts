import type {DisplayedNotification} from '@notifee/react-native'
import {describe, expect, it} from 'vitest'
import {idFromString, Trigger} from '../services/notification-types'
import {
  deriveSweptTrigger,
  eventFromDisplayed,
  resolveDeliveryDate,
  resolveStableId,
  sortDisplayedForImport,
} from './notification-sweep-pure'

function displayed(partial: {
  id?: string
  messageId?: string
  notifId?: string
  date?: string
  title?: string
  body?: string
  data?: Record<string, unknown>
}): DisplayedNotification {
  const remote = partial.messageId != null ? {messageId: partial.messageId} : undefined
  return {
    id: partial.id ?? 'display-1',
    date: partial.date,
    notification: {
      id: partial.notifId,
      title: partial.title ?? '',
      body: partial.body ?? '',
      data: partial.data,
      ...(remote ? {remote} : {}),
    },
  } as DisplayedNotification
}

describe('resolveStableId', () => {
  it('prefers FCM remote.messageId', () => {
    expect(resolveStableId(displayed({messageId: 'fcm-msg-1', notifId: 'other', id: 'display'}))).toEqual({
      kind: 'ok',
      id: 'fcm-msg-1',
      source: 'remote-messageId',
    })
  })

  it('falls back to notification.id', () => {
    expect(resolveStableId(displayed({notifId: 'pinned-id'}))).toEqual({
      kind: 'ok',
      id: 'pinned-id',
      source: 'notif-id',
    })
  })

  it('falls back to displayed.id when only that is present', () => {
    expect(resolveStableId(displayed({id: 'display-only'}))).toEqual({
      kind: 'ok',
      id: 'display-only',
      source: 'displayed-id',
    })
  })

  it('returns missing when no id source exists', () => {
    const notif = displayed({})
    notif.id = ''
    notif.notification.id = ''
    expect(resolveStableId(notif)).toEqual({kind: 'missing'})
  })
})

describe('resolveDeliveryDate', () => {
  it('parses notifee millisecond timestamp string', () => {
    expect(resolveDeliveryDate(displayed({date: '1715785075000'}), {})).toEqual({
      kind: 'ok',
      date: '2024-05-15T14:57:55.000Z',
      source: 'notifee-date',
    })
  })

  it('parses notifee ISO date', () => {
    expect(resolveDeliveryDate(displayed({date: '2024-06-01T12:00:00.000Z'}), {})).toEqual({
      kind: 'ok',
      date: '2024-06-01T12:00:00.000Z',
      source: 'notifee-date',
    })
  })

  it('parses google.sent_time from data payload', () => {
    expect(resolveDeliveryDate(displayed({}), {'google.sent_time': '1715785075000'})).toEqual({
      kind: 'ok',
      date: '2024-05-15T14:57:55.000Z',
      source: 'fcm-sent-time',
    })
  })

  it('returns missing when no timestamp source exists', () => {
    expect(resolveDeliveryDate(displayed({}), {})).toEqual({kind: 'missing'})
  })
})

describe('eventFromDisplayed', () => {
  it('hashes messageId to the same id as idFromString and tags source', () => {
    const result = eventFromDisplayed(displayed({messageId: 'abc', date: '2024-06-01T12:00:00.000Z', title: 'Hi'}))
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.event.id).toBe(idFromString('abc'))
      expect(result.idSource).toBe('remote-messageId')
      expect(result.dateSource).toBe('notifee-date')
    }
  })

  it('hashes canonical FCM messageIds via the id (not the date)', () => {
    // Regression: a `Number(idResult.id)` truthy-check briefly replaced the
    // explicit `'0'` sentinel and made every non-numeric id (incl. canonical
    // FCM messageIds and card-partner UUIDs) fall through to a date-hash. That
    // broke dedup against the headless-handler-stored row — the same push
    // would show up twice in the inbox.
    const fcmMessageId = '0:1730837234567890%1234abcd'
    const result = eventFromDisplayed(
      displayed({messageId: fcmMessageId, date: '2024-06-01T12:00:00.000Z', title: 'Hi'}),
    )
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.event.id).toBe(idFromString(fcmMessageId))
      // Must NOT have fallen through to the date-hash branch.
      expect(result.event.id).not.toBe(idFromString('2024-06-01T12:00:00.000Z'))
    }
  })

  it('falls back to date-hash when notif id is the Android FCM placeholder "0"', () => {
    // Android's FCM service auto-displays "notification" pushes with id `'0'`
    // (every push shares the placeholder); without the fallback, every Android
    // background-displayed notif would collapse onto one inbox row.
    const result = eventFromDisplayed(
      displayed({notifId: '0', date: '2024-06-01T12:00:00.000Z', title: 'Crypto Deposit Completed'}),
    )
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.event.id).toBe(idFromString('2024-06-01T12:00:00.000Z'))
      // Different dates → different ids (the whole point of the fallback).
      const later = eventFromDisplayed(
        displayed({notifId: '0', date: '2024-06-01T13:00:00.000Z', title: 'Crypto Deposit Completed'}),
      )
      if (later.kind === 'ok') expect(later.event.id).not.toBe(result.event.id)
    }
  })

  it('drops with reason=no-stable-id when no id can be derived', () => {
    const notif = displayed({})
    notif.id = ''
    notif.notification.id = ''
    expect(eventFromDisplayed(notif)).toEqual({kind: 'dropped', reason: 'no-stable-id', idSource: null})
  })

  it('drops with reason=no-delivery-date when id present but no timestamp', () => {
    expect(eventFromDisplayed(displayed({messageId: 'x'}))).toEqual({
      kind: 'dropped',
      reason: 'no-delivery-date',
      idSource: 'remote-messageId',
    })
  })
})

describe('deriveSweptTrigger', () => {
  it('maps transaction screens', () => {
    expect(deriveSweptTrigger({screen: 'transaction_detail'})).toBe(Trigger.Transaction)
  })
})

describe('sortDisplayedForImport', () => {
  it('orders oldest first for prepend-friendly import', () => {
    const older = displayed({messageId: 'old', date: '2024-01-01T00:00:00.000Z'})
    const newer = displayed({messageId: 'new', date: '2024-06-01T00:00:00.000Z'})
    const sorted = sortDisplayedForImport([newer, older])
    const ids = sorted.map((d) => {
      const r = resolveStableId(d)
      return r.kind === 'ok' ? r.id : null
    })
    expect(ids).toEqual(['old', 'new'])
  })
})
