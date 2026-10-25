import {REDACTED} from '@pnyx/logger'
import {describe, expect, it} from 'vitest'
import {type ScrubbableEvent, scrubBreadcrumb, scrubSentryEvent} from './scrub-sentry'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('scrubSentryEvent', () => {
  it('scrubs a mnemonic in a string message', () => {
    expect(scrubSentryEvent({message: MNEMONIC}).message).toBe(REDACTED)
  })

  it('scrubs a structured message', () => {
    const out = scrubSentryEvent({message: {message: MNEMONIC, formatted: MNEMONIC}})
    expect(out.message).toEqual({message: REDACTED, formatted: REDACTED})
  })

  // This is the path the logger chokepoint cannot see: an unhandled throw Sentry
  // catches by itself.
  it('scrubs an exception value from an unhandled throw', () => {
    const out = scrubSentryEvent({
      exception: {values: [{type: 'InvalidMnemonicError', value: MNEMONIC}]},
    })
    expect(out.exception?.values?.[0]?.value).toBe(REDACTED)
  })

  // Grouping keys off the type, and a class name is not a secret.
  it('keeps the exception type so Sentry grouping still works', () => {
    const out = scrubSentryEvent({exception: {values: [{type: 'InvalidMnemonicError', value: MNEMONIC}]}})
    expect(out.exception?.values?.[0]?.type).toBe('InvalidMnemonicError')
  })

  it('scrubs extra, contexts and tags by key name', () => {
    const out = scrubSentryEvent({
      extra: {mnemonic: 'x', groupId: 'group-1'},
      contexts: {vault: {xprv: 'deadbeef', slot: 'pnyx-identity'}},
      tags: {password: 'hunter2', network: 'mainnet'},
    })
    expect(out.extra).toEqual({mnemonic: REDACTED, groupId: 'group-1'})
    expect(out.contexts).toEqual({vault: {xprv: REDACTED, slot: 'pnyx-identity'}})
    expect(out.tags).toEqual({password: REDACTED, network: 'mainnet'})
  })

  it('scrubs breadcrumbs carried on the event', () => {
    const out = scrubSentryEvent({breadcrumbs: [{message: MNEMONIC, data: {seed: 'x'}}]})
    expect(out.breadcrumbs?.[0]).toMatchObject({message: REDACTED, data: {seed: REDACTED}})
  })

  it('leaves an event with nothing sensitive untouched', () => {
    const event: ScrubbableEvent = {
      message: 'submit rejected (400): All inputs are spent',
      extra: {txHash: '8394018e46542e39147e88c717d4dfdaaca7bcd8182ebd2103456744e9ac5700', fee: 340_000},
      tags: {network: 'mainnet'},
    }
    expect(scrubSentryEvent(event)).toEqual(event)
  })

  it('does not invent fields the event did not have', () => {
    expect(Object.keys(scrubSentryEvent({}))).toEqual([])
  })

  it('does not mutate the event it was given', () => {
    const event: ScrubbableEvent = {extra: {mnemonic: MNEMONIC}}
    scrubSentryEvent(event)
    expect(event.extra?.mnemonic).toBe(MNEMONIC)
  })
})

describe('scrubBreadcrumb', () => {
  // Sentry auto-collects console breadcrumbs, so a stray console.log that never
  // touched our logger arrives here.
  it('scrubs an auto-collected console breadcrumb', () => {
    const out = scrubBreadcrumb({category: 'console', level: 'log', message: MNEMONIC})
    expect(out.message).toBe(REDACTED)
    expect(out.category).toBe('console')
  })

  it('scrubs breadcrumb data by key name', () => {
    expect(scrubBreadcrumb({data: {privateKey: 'abc', url: 'https://koios'}}).data).toEqual({
      privateKey: REDACTED,
      url: 'https://koios',
    })
  })

  it('keeps an ordinary navigation breadcrumb intact', () => {
    const crumb = {category: 'navigation', data: {from: '/wallets', to: '/wallet/send'}}
    expect(scrubBreadcrumb(crumb)).toEqual(crumb)
  })
})
