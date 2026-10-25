import {Effect, Either} from 'effect'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {submitSealedTransaction} from './submit-sealed'
import {MIDNIGHT_CALL_ENCODING} from './substrate-extrinsic'

/** Every assertion reads the typed failure rather than a thrown value — the whole point of the change. */
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.either(effect))

vi.mock('../../logger', () => ({
  logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
}))

const okRuntime = {
  specName: MIDNIGHT_CALL_ENCODING.specName,
  transactionVersion: MIDNIGHT_CALL_ENCODING.transactionVersion,
}

/**
 * A WebSocket that answers each JSON-RPC method from `answers`, recording every call it was given.
 *
 * ⚠️ The answer echoes the request's **id**. The implementation matches replies by id because substrate
 * may interleave them, so a mock that always answered `id: 1` would pass while the real thing hung.
 */
const rpcSocket = (answers: Record<string, unknown>, options: {readonly failToOpen?: boolean} = {}) => {
  const calls: {url: string; method: string; params: unknown[]}[] = []
  class FakeSocket {
    onopen: (() => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    onclose: (() => void) | null = null
    onmessage: ((event: {data: unknown}) => void) | null = null
    closed = false
    constructor(readonly url: string) {
      queueMicrotask(() => {
        if (options.failToOpen === true) this.onerror?.({message: 'refused'})
        else this.onopen?.()
      })
    }
    send(raw: string) {
      const {id, method, params} = JSON.parse(raw) as {id: number; method: string; params: unknown[]}
      calls.push({url: this.url, method, params})
      const answer = answers[method]
      if (answer === undefined) throw new Error(`test socket has no answer for ${method}`)
      queueMicrotask(() => this.onmessage?.({data: JSON.stringify({jsonrpc: '2.0', id, ...(answer as object)})}))
    }
    close() {
      this.closed = true
    }
  }
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket)
  // Stubbed so a test can assert it is never used: the HTTP front end caps a request body at 8 KiB and
  // silently 403s past it, which is the whole reason this rail is a socket.
  vi.stubGlobal('fetch', vi.fn())
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('submitSealedTransaction', () => {
  it('checks the runtime, then submits the framed extrinsic as hex', async () => {
    const calls = rpcSocket({
      state_getRuntimeVersion: {result: okRuntime},
      author_submitExtrinsic: {result: '0xabc123'},
    })

    const result = await Effect.runPromise(
      submitSealedTransaction({transaction: Uint8Array.from([1, 2, 3, 4]), network: 'preprod'}),
    )

    expect(calls.map((c) => c.method)).toEqual(['state_getRuntimeVersion', 'author_submitExtrinsic'])
    expect(calls[0]?.url).toBe('wss://rpc.preprod.midnight.network')
    expect(calls[1]?.params).toEqual(['0x200405001001020304'])
    expect(result).toEqual({extrinsicHash: '0xabc123', extrinsicBytes: 9})
  })

  it('refuses a network it has no node endpoint for, without calling anything', async () => {
    const calls = rpcSocket({})

    // A name the table has never carried — `preview` used to stand in here and now resolves.
    const outcome = await run(submitSealedTransaction({transaction: Uint8Array.from([1]), network: 'devnet'}))
    expect(Either.isLeft(outcome)).toBe(true)
    if (Either.isLeft(outcome)) expect(outcome.left.reason).toMatch(/no Midnight node socket for network 'devnet'/)
    expect(calls).toEqual([])
  })

  it('refuses to submit when the runtime has moved past the encoding we pinned', async () => {
    const calls = rpcSocket({
      state_getRuntimeVersion: {
        result: {specName: 'midnight', transactionVersion: okRuntime.transactionVersion + 1},
      },
      author_submitExtrinsic: {result: '0xabc123'},
    })

    const outcome = await run(submitSealedTransaction({transaction: Uint8Array.from([1]), network: 'preprod'}))
    expect(Either.isLeft(outcome)).toBe(true)
    if (Either.isLeft(outcome)) expect(outcome.left.reason).toMatch(/transactionVersion/)
    expect(calls.map((c) => c.method)).toEqual(['state_getRuntimeVersion'])
  })

  it('carries the ledger’s own rejection through instead of flattening it', async () => {
    rpcSocket({
      state_getRuntimeVersion: {result: okRuntime},
      author_submitExtrinsic: {
        // `message` is the same generic line for every rejection; `data` is the only part that names
        // which rule was broken, so a thrown error that omits it diagnoses nothing.
        error: {code: 1010, message: 'Invalid Transaction', data: 'Custom error: 182'},
      },
    })

    const outcome = await run(submitSealedTransaction({transaction: Uint8Array.from([1]), network: 'preprod'}))
    expect(Either.isLeft(outcome)).toBe(true)
    if (Either.isLeft(outcome)) {
      expect(outcome.left.reason).toBe(
        'author_submitExtrinsic was rejected: 1010 Invalid Transaction ("Custom error: 182") — Malformed::TransactionApplicationError',
      )
    }
  })

  // A rejection is the node saying no, which means nothing is in flight and `prefer-self` may fall back.
  // A transport failure says nothing about whether the transaction was taken, so it must not.
  it('marks a node rejection as definitive, and a transport failure as not', async () => {
    rpcSocket({
      state_getRuntimeVersion: {result: okRuntime},
      author_submitExtrinsic: {error: {code: 1010, message: 'Invalid Transaction'}},
    })
    const rejection = await run(submitSealedTransaction({transaction: Uint8Array.from([1]), network: 'preprod'}))
    expect(Either.isLeft(rejection)).toBe(true)
    // The distinction the sponsor fallback turns on: only this one means nothing is in flight.
    if (Either.isLeft(rejection)) expect(rejection.left.cause).toBe('rejected')

    rpcSocket({}, {failToOpen: true})
    const transport = await run(submitSealedTransaction({transaction: Uint8Array.from([1]), network: 'preprod'}))
    expect(Either.isLeft(transport)).toBe(true)
    // ⚠️ Must never be `rejected`: falling back to the sponsor on an unreachable node can send the
    // same money twice.
    if (Either.isLeft(transport)) expect(transport.left.cause).toBe('unreachable')
  })

  /**
   * ⚠️ **The transport is the feature.** The node's HTTP front end refuses a request body over 8 KiB
   * with a bare nginx 403 — measured on preprod — and a transaction is hex inside JSON, so that caps
   * HTTP at roughly 4 KB of transaction and excludes every contract call. Submitting over `fetch` at
   * all is therefore the bug, not a detail, and it fails in a way that names nothing.
   */
  it('never touches HTTP, whatever the size', async () => {
    const calls = rpcSocket({
      state_getRuntimeVersion: {result: okRuntime},
      author_submitExtrinsic: {result: '0xabc123'},
    })
    // Comfortably past the HTTP cap: 6 KB of transaction is over 12 KB of hex once framed.
    await Effect.runPromise(submitSealedTransaction({transaction: new Uint8Array(6_000).fill(7), network: 'preprod'}))
    expect(calls.map((c) => c.method)).toEqual(['state_getRuntimeVersion', 'author_submitExtrinsic'])
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('treats a response with neither result nor error as a failure', async () => {
    rpcSocket({
      state_getRuntimeVersion: {result: okRuntime},
      author_submitExtrinsic: {},
    })

    const outcome = await run(submitSealedTransaction({transaction: Uint8Array.from([1]), network: 'preprod'}))
    expect(Either.isLeft(outcome)).toBe(true)
    if (Either.isLeft(outcome)) expect(outcome.left.reason).toMatch(/neither a result nor an error/)
  })
})
