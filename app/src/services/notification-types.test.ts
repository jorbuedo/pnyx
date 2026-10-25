import {describe, expect, it} from 'vitest'
import {
  defaultNotificationConfig,
  idFromString,
  isLocallyReconciled,
  PushNavigationTarget,
  parseScreenTarget,
  Trigger,
  triggerForKind,
  triggerGroups,
} from './notification-types'

describe('idFromString', () => {
  it('is stable for the same messageId', () => {
    expect(idFromString('fcm:0:123')).toBe(idFromString('fcm:0:123'))
  })

  it('differs for different messageIds', () => {
    expect(idFromString('msg-a')).not.toBe(idFromString('msg-b'))
  })
})

describe('parseScreenTarget', () => {
  it('returns the matching enum for canonical snake_case', () => {
    expect(parseScreenTarget('transaction_detail')).toBe(PushNavigationTarget.TransactionDetail)
    expect(parseScreenTarget('governance_drep')).toBe(PushNavigationTarget.GovernanceDrep)
    expect(parseScreenTarget('home')).toBe(PushNavigationTarget.Home)
  })

  it('accepts camelCase aliases (backends have shipped mixed casings)', () => {
    expect(parseScreenTarget('transactionDetail')).toBe(PushNavigationTarget.TransactionDetail)
    expect(parseScreenTarget('governanceDrep')).toBe(PushNavigationTarget.GovernanceDrep)
    expect(parseScreenTarget('nftDetail')).toBe(PushNavigationTarget.NftDetail)
  })

  it('accepts kebab-case + mixed casing', () => {
    expect(parseScreenTarget('transaction-detail')).toBe(PushNavigationTarget.TransactionDetail)
    expect(parseScreenTarget('Transaction_Detail')).toBe(PushNavigationTarget.TransactionDetail)
  })

  it('returns undefined for unrecognized values', () => {
    expect(parseScreenTarget('totally_made_up')).toBeUndefined()
    expect(parseScreenTarget('')).toBeUndefined()
    expect(parseScreenTarget(undefined)).toBeUndefined()
    expect(parseScreenTarget(null)).toBeUndefined()
    expect(parseScreenTarget(42)).toBeUndefined()
  })
})

describe('isLocallyReconciled', () => {
  it('claims the DM kinds, whose inbox row the app builds from its own state', () => {
    // Every push path must skip these. When they did not, a DM produced two rows: the generic one
    // the push carried, written *after* the reconciliation that was meant to replace it.
    expect(isLocallyReconciled({kind: 'dm-message'})).toBe(true)
    expect(isLocallyReconciled({kind: 'dm-invite'})).toBe(true)
  })

  it('leaves every other kind to the push paths', () => {
    expect(isLocallyReconciled({kind: 'post-reply'})).toBe(false)
    expect(isLocallyReconciled({})).toBe(false)
    expect(isLocallyReconciled(undefined)).toBe(false)
  })

  it('ignores a non-string kind rather than throwing on it', () => {
    expect(isLocallyReconciled({kind: 7 as unknown as string})).toBe(false)
  })
})

// The kind is what a per-category setting acts on: without this mapping every push lands in the
// ungoverned catch-all, and a toggle that governs nothing is a switch that does nothing.
describe('triggerForKind', () => {
  it('routes every kind the content service sends to a category', () => {
    expect(triggerForKind({kind: 'dm-message'})).toBe(Trigger.DirectMessage)
    expect(triggerForKind({kind: 'dm-invite'})).toBe(Trigger.DirectMessage)
    expect(triggerForKind({kind: 'post-reply'})).toBe(Trigger.Forum)
    expect(triggerForKind({kind: 'new-proposal'})).toBe(Trigger.Forum)
    expect(triggerForKind({kind: 'poll-result'})).toBe(Trigger.Forum)
  })

  it('names no category for a kind it does not know, rather than guessing one', () => {
    expect(triggerForKind({kind: 'something-new'})).toBeUndefined()
    expect(triggerForKind({kind: 42})).toBeUndefined()
    expect(triggerForKind({})).toBeUndefined()
    expect(triggerForKind(undefined)).toBeUndefined()
  })
})

describe('notification categories', () => {
  // A trigger with no default reads as `undefined`, which `shouldNotify` treats as off — that is how
  // a category nobody switched off goes silently mute.
  it('gives every trigger a default and a group', () => {
    for (const trigger of Object.values(Trigger)) {
      expect(defaultNotificationConfig[trigger]?.notify, trigger).toBe(true)
      expect(triggerGroups[trigger], trigger).toBeTypeOf('string')
    }
  })
})
