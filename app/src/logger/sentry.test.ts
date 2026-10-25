import {LogLevel} from '@pnyx/logger'
import {describe, expect, it, vi} from 'vitest'
import {createSentryTransport} from './sentry'

type ScopeCalls = {
  setTags: Array<Record<string, string>>
  setExtras: Array<Record<string, unknown>>
  captureMessage: Array<{message: string; level: string | undefined}>
  captureException: unknown[]
}

const makeSentryMock = () => {
  const breadcrumbs: unknown[] = []
  const captures: Array<{type: 'message' | 'exception'; payload: unknown; hint?: unknown}> = []
  const scopes: ScopeCalls[] = []
  const sentry = {
    addBreadcrumb: (b: unknown) => breadcrumbs.push(b),
    captureMessage: (m: string, l?: string) => captures.push({type: 'message', payload: {m, l}}),
    captureException: (e: unknown, hint?: unknown) => captures.push({type: 'exception', payload: e, hint}),
    // biome-ignore lint/suspicious/noExplicitAny: structural mock — `SentryScope` is satisfied by `scopeProxy`
    withScope: (cb: (scope: any) => void) => {
      const scope: ScopeCalls = {
        setTags: [],
        setExtras: [],
        captureMessage: [],
        captureException: [],
      }
      const scopeProxy = {
        setTags: (t: Record<string, string>) => scope.setTags.push(t),
        setExtras: (e: Record<string, unknown>) => scope.setExtras.push(e),
        captureMessage: (m: string, l?: string) => scope.captureMessage.push({message: m, level: l}),
        captureException: (e: unknown) => scope.captureException.push(e),
      }
      cb(scopeProxy)
      scopes.push(scope)
    },
  }
  return {sentry, breadcrumbs, captures, scopes}
}

describe('createSentryTransport', () => {
  const ts = 1715785075000

  it('adds a breadcrumb with the origin as category and severity from log level', () => {
    const {sentry, breadcrumbs} = makeSentryMock()
    const transport = createSentryTransport(sentry)
    transport({level: LogLevel.Info, message: 'hi', metadata: {origin: 'useTest'}, timestamp: ts})
    expect(breadcrumbs).toEqual([
      {
        type: 'default',
        category: 'useTest',
        message: 'hi',
        level: 'info',
        timestamp: ts / 1000,
      },
    ])
  })

  it('passes metadata extras (minus origin/type/tags) as breadcrumb data', () => {
    const {sentry, breadcrumbs} = makeSentryMock()
    const transport = createSentryTransport(sentry)
    transport({
      level: LogLevel.Warn,
      message: 'almost-bad',
      metadata: {origin: 'x', chain: 'cardano', userId: 'a1'},
      timestamp: ts,
    })
    expect((breadcrumbs[0] as {data?: unknown}).data).toEqual({chain: 'cardano', userId: 'a1'})
  })

  it('does not capture events for Debug/Info levels', () => {
    const {sentry, captures, scopes} = makeSentryMock()
    const transport = createSentryTransport(sentry)
    transport({level: LogLevel.Debug, message: 'd', metadata: {}, timestamp: ts})
    transport({level: LogLevel.Info, message: 'i', metadata: {}, timestamp: ts})
    expect(captures).toEqual([])
    expect(scopes).toEqual([])
  })

  it('captures a warning message when no tags or extras are present', () => {
    const {sentry, captures, scopes} = makeSentryMock()
    const transport = createSentryTransport(sentry)
    transport({level: LogLevel.Warn, message: 'noisy', metadata: {origin: 'x'}, timestamp: ts})
    expect(scopes).toEqual([])
    expect(captures).toEqual([{type: 'message', payload: {m: 'noisy', l: 'warning'}}])
  })

  it('captures an exception with origin extra when Error is passed and no tags/extras are set', () => {
    const {sentry, captures} = makeSentryMock()
    const transport = createSentryTransport(sentry)
    const err = new Error('boom')
    transport({level: LogLevel.Error, message: err, metadata: {origin: 'mod'}, timestamp: ts})
    expect(captures).toHaveLength(1)
    expect(captures[0]).toMatchObject({type: 'exception', payload: err, hint: {extra: {origin: 'mod'}}})
  })

  it('promotes metadata.tags onto a Sentry scope and always attaches origin to extras', () => {
    const {sentry, scopes, captures} = makeSentryMock()
    const transport = createSentryTransport(sentry)
    transport({
      level: LogLevel.Error,
      message: 'fail',
      metadata: {origin: 'useSigningService', tags: {errorReference: 'ERR-XYZ', chain: 'cardano'}},
      timestamp: ts,
    })
    expect(scopes).toHaveLength(1)
    expect(scopes[0]?.setTags).toEqual([{errorReference: 'ERR-XYZ', chain: 'cardano'}])
    // The bug Cursor Bugbot caught: origin must reach the scope even when
    // there are no other "extra" fields besides tags.
    expect(scopes[0]?.setExtras).toEqual([{origin: 'useSigningService'}])
    expect(scopes[0]?.captureMessage).toEqual([{message: 'fail', level: 'error'}])
    expect(captures).toEqual([])
  })

  it('merges origin with other extras when both are present', () => {
    const {sentry, scopes} = makeSentryMock()
    const transport = createSentryTransport(sentry)
    transport({
      level: LogLevel.Error,
      message: 'fail',
      metadata: {origin: 'mod', userId: 'u1', tags: {chain: 'btc'}},
      timestamp: ts,
    })
    expect(scopes[0]?.setExtras).toEqual([{userId: 'u1', origin: 'mod'}])
  })

  it('coerces number/boolean tag values to strings and drops other types', () => {
    const {sentry, scopes} = makeSentryMock()
    const transport = createSentryTransport(sentry)
    transport({
      level: LogLevel.Warn,
      message: 'tagged',
      metadata: {tags: {a: 'str', b: 42, c: true, d: {} as unknown as string, e: undefined as unknown as string}},
      timestamp: ts,
    })
    expect(scopes[0]?.setTags).toEqual([{a: 'str', b: '42', c: 'true'}])
  })

  it('uses captureException on Error inside withScope path', () => {
    const {sentry, scopes} = makeSentryMock()
    const transport = createSentryTransport(sentry)
    const err = new Error('woops')
    transport({
      level: LogLevel.Error,
      message: err,
      metadata: {origin: 'x', tags: {chain: 'cardano'}},
      timestamp: ts,
    })
    expect(scopes[0]?.captureException).toEqual([err])
    expect(scopes[0]?.captureMessage).toEqual([])
  })

  it('uses the message itself as the captured string for Error-warn entries', () => {
    const {sentry, captures} = makeSentryMock()
    const transport = createSentryTransport(sentry)
    const err = new Error('soft-fail')
    transport({level: LogLevel.Warn, message: err, metadata: {}, timestamp: ts})
    expect(captures[0]).toMatchObject({type: 'message', payload: {m: 'soft-fail', l: 'warning'}})
  })

  it('ignores a non-object tags field', () => {
    const {sentry, scopes, captures} = makeSentryMock()
    const transport = createSentryTransport(sentry)
    transport({
      level: LogLevel.Warn,
      message: 'tagless',
      metadata: {tags: 'string-tag' as unknown as Record<string, string>},
      timestamp: ts,
    })
    // No scope path was triggered because tags sanitized to null and no
    // extras present; fallback captureMessage runs instead.
    expect(scopes).toEqual([])
    expect(captures).toEqual([{type: 'message', payload: {m: 'tagless', l: 'warning'}}])
  })
})

// Silence unused-vi import — keeps the mock helper terse without disabling
// vi-driven spies when callers expand the suite later.
void vi
