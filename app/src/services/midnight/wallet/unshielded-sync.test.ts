import {Effect, Either} from 'effect'
import {describe, expect, it, vi} from 'vitest'
import type {SocketEvents, SocketFactory} from './graphql-ws'

import {indexerWsUrl, syncUnshielded} from './unshielded-sync'

const ADDRESS = 'mn_addr_preprod1ours'
const NIGHT = '0100000000000000000000000000000000000000000000000000000000000000'

/**
 * A socket that replays a scripted server. Frames are delivered in response to what the client sends,
 * so the handshake is exercised rather than bypassed.
 */
const scripted = (
  frames: readonly unknown[],
  options: {readonly onSend?: (data: string) => void} = {},
): {factory: SocketFactory; sent: string[]; closed: () => number} => {
  const sent: string[] = []
  let closes = 0
  const factory: SocketFactory = (_url, _protocol, events: SocketEvents) => {
    const deliver = (frame: unknown) => events.onMessage(JSON.stringify(frame))
    setTimeout(() => events.onOpen(), 0)
    return {
      send: (data) => {
        sent.push(data)
        options.onSend?.(data)
        const parsed = JSON.parse(data) as {type?: string}
        if (parsed.type === 'connection_init') setTimeout(() => deliver({type: 'connection_ack'}), 0)
        if (parsed.type === 'subscribe') setTimeout(() => frames.forEach(deliver), 0)
      },
      close: () => {
        closes += 1
      },
    }
  }
  return {factory, sent, closed: () => closes}
}

const progress = (highestTransactionId: number) => ({
  type: 'next',
  id: '1',
  payload: {data: {unshieldedTransactions: {__typename: 'UnshieldedTransactionsProgress', highestTransactionId}}},
})

const txEvent = (
  id: number,
  created: readonly Record<string, unknown>[] = [],
  spent: readonly Record<string, unknown>[] = [],
) => ({
  type: 'next',
  id: '1',
  payload: {
    data: {
      unshieldedTransactions: {
        __typename: 'UnshieldedTransaction',
        transaction: {id, hash: `hash${id}`},
        createdUtxos: created,
        spentUtxos: spent,
      },
    },
  },
})

const utxo = (over: Record<string, unknown> = {}) => ({
  owner: ADDRESS,
  tokenType: NIGHT,
  value: '1000000',
  intentHash: 'aa11',
  outputIndex: 0,
  ctime: 1_700_000_000,
  registeredForDustGeneration: false,
  ...over,
})

describe('indexerWsUrl', () => {
  it('derives the socket URL from the HTTP one', () => {
    expect(indexerWsUrl('https://indexer.preprod.midnight.network/api/v4/graphql')).toBe(
      'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    )
    expect(indexerWsUrl('http://127.0.0.1:8088/api/v4/graphql')).toBe('ws://127.0.0.1:8088/api/v4/graphql/ws')
  })

  it('does not double a trailing slash', () => {
    expect(indexerWsUrl('http://127.0.0.1:8088/api/v4/graphql/')).toBe('ws://127.0.0.1:8088/api/v4/graphql/ws')
  })

  it('puts /ws on the path, not after a credential the url carries', () => {
    // The defect this replaced appended `/ws` to the whole string, producing
    // `…/graphql?project_id=KEY/ws` — refused by the server, and the form every dust and unshielded
    // subscription built on preprod.
    expect(indexerWsUrl('https://midnight-preprod.blockfrost.io/api/v4/graphql?project_id=KEY')).toBe(
      'wss://midnight-preprod.blockfrost.io/api/v4/graphql/ws?project_id=KEY',
    )
  })
})

describe('syncUnshielded', () => {
  it('refuses a network it has no indexer for, rather than reporting an empty wallet', async () => {
    const failure = await Effect.runPromise(Effect.either(syncUnshielded({address: ADDRESS, network: 'nosuchnet'})))
    expect(Either.isLeft(failure)).toBe(true)
    if (Either.isLeft(failure)) {
      // The discriminant, not just the text: no retry fixes a build with no indexer for the network,
      // and a caller has to be able to tell that from a socket that dropped.
      expect(failure.left.cause).toBe('not-configured')
      expect(failure.left.reason).toMatch(/no indexer configured/)
    }
  })

  it('reads an address with no history as caught up and empty', async () => {
    // What the live preprod indexer answers for an unused address: progress with highest id 0.
    const {factory, closed} = scripted([progress(0)])
    const result = await Effect.runPromise(
      syncUnshielded({address: ADDRESS, network: 'preprod', socketFactory: factory}),
    )
    expect(result.utxos.size).toBe(0)
    expect(result.highestTransactionId).toBe(0)
    expect(result.caughtUp).toBe(true)
    expect(closed()).toBe(1)
  })

  it('folds the replay and stops once it reaches the highest id', async () => {
    const {factory} = scripted([progress(2), txEvent(1, [utxo()]), txEvent(2, [utxo({outputIndex: 1})])])
    const result = await Effect.runPromise(
      syncUnshielded({address: ADDRESS, network: 'preprod', socketFactory: factory}),
    )
    expect(result.transactionsApplied).toBe(2)
    expect(result.utxos.size).toBe(2)
    expect(result.caughtUp).toBe(true)
  })

  it('does not stop on the leading progress frame when there is history to replay', async () => {
    // The regression this guards: progress arrives first, so treating it as "done" reads every funded
    // address as empty.
    const {factory} = scripted([progress(1), txEvent(1, [utxo()])])
    const result = await Effect.runPromise(
      syncUnshielded({address: ADDRESS, network: 'preprod', socketFactory: factory}),
    )
    expect(result.transactionsApplied).toBe(1)
    expect(result.utxos.size).toBe(1)
  })

  it('drops a UTxO the replay later spends', async () => {
    const {factory} = scripted([progress(2), txEvent(1, [utxo()]), txEvent(2, [], [utxo()])])
    const result = await Effect.runPromise(
      syncUnshielded({address: ADDRESS, network: 'preprod', socketFactory: factory}),
    )
    expect(result.utxos.size).toBe(0)
    expect(result.caughtUp).toBe(true)
  })

  it('resumes from a cursor without re-reading history', async () => {
    const {factory, sent} = scripted([progress(5), txEvent(5, [utxo({outputIndex: 3})])])
    const seed = new Map([['aa11:0', {...utxo(), value: 1_000_000n, tokenType: NIGHT, ctime: null}]])
    const result = await Effect.runPromise(
      syncUnshielded({
        address: ADDRESS,
        network: 'preprod',
        from: {utxos: seed as never, transactionId: 4},
        socketFactory: factory,
      }),
    )
    const subscribe = sent.map(
      (s) => JSON.parse(s) as {type?: string; payload?: {variables?: {transactionId?: number}}},
    )
    expect(subscribe.find((m) => m.type === 'subscribe')?.payload?.variables?.transactionId).toBe(4)
    // The seeded UTxO survives and the replayed one is added.
    expect(result.utxos.size).toBe(2)
  })

  it('propagates a GraphQL error instead of returning an empty set', async () => {
    // A wrong-HRP address answers exactly this way on the live indexer.
    const {factory} = scripted([
      {type: 'next', id: '1', payload: {data: null, errors: [{message: 'expected HRP mn_addr_preprod'}]}},
    ])
    const failure = await Effect.runPromise(
      Effect.either(syncUnshielded({address: ADDRESS, network: 'preprod', socketFactory: factory})),
    )
    expect(Either.isLeft(failure)).toBe(true)
    if (Either.isLeft(failure)) {
      expect(failure.left.cause).toBe('transport')
      expect(failure.left.reason).toMatch(/expected HRP mn_addr_preprod/)
    }
  })

  it('answers a ping so the server does not drop the socket', async () => {
    const {factory, sent} = scripted([{type: 'ping'}, progress(0)])
    await Effect.runPromise(syncUnshielded({address: ADDRESS, network: 'preprod', socketFactory: factory}))
    expect(sent.some((s) => (JSON.parse(s) as {type?: string}).type === 'pong')).toBe(true)
  })

  it('treats a close before any payload as a failure, not an empty wallet', async () => {
    const factory: SocketFactory = (_url, _protocol, events) => {
      setTimeout(() => events.onOpen(), 0)
      return {
        send: () => setTimeout(() => events.onClose({code: 1006, reason: 'abnormal'}), 0),
        close: () => undefined,
      }
    }
    const failure = await Effect.runPromise(
      Effect.either(syncUnshielded({address: ADDRESS, network: 'preprod', socketFactory: factory})),
    )
    expect(Either.isLeft(failure)).toBe(true)
    if (Either.isLeft(failure)) {
      expect(failure.left.cause).toBe('transport')
      expect(failure.left.reason).toMatch(/closed before any payload/)
    }
  })

  it('gives up after the timeout rather than hanging when the server says nothing', async () => {
    vi.useFakeTimers()
    try {
      const factory: SocketFactory = (_url, _protocol, events) => {
        events.onOpen()
        return {send: () => undefined, close: () => undefined}
      }
      const pending = Effect.runPromise(
        syncUnshielded({address: ADDRESS, network: 'preprod', socketFactory: factory, timeoutMs: 5_000}),
      )
      await vi.advanceTimersByTimeAsync(5_000)
      const result = await pending
      expect(result.utxos.size).toBe(0)
      // Nothing was heard, so "caught up" cannot be claimed from a highest id we never received.
      expect(result.highestTransactionId).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
