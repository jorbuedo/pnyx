import {describe, expect, it, vi} from 'vitest'

vi.mock('../../logger', () => ({logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}}))

import {probeEndpoint} from './endpoint-probe'

const jsonResponse = (body: unknown, ok = true, status = 200) =>
  ({ok, status, json: async () => body}) as unknown as Response

const socketStub = () => {
  const handlers: {onopen: (() => void) | null; onerror: (() => void) | null} = {onopen: null, onerror: null}
  return {
    handlers,
    open: (url: string) => {
      const socket = {
        close: () => {},
        get onopen() {
          return handlers.onopen
        },
        set onopen(v) {
          handlers.onopen = v
        },
        get onerror() {
          return handlers.onerror
        },
        set onerror(v) {
          handlers.onerror = v
        },
        url,
      }
      return socket as never
    },
  }
}

describe('probeEndpoint — indexer', () => {
  it('accepts an answer carrying a block height, and says which block', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({data: {block: {height: 2822587}}}))
    await expect(
      probeEndpoint('indexer', 'https://i.example.com/graphql', {fetchImpl: fetchImpl as never}),
    ).resolves.toEqual({
      status: 'accepted',
      detail: 'block 2822587',
    })
  })

  it('refuses a 200 that carries GraphQL errors', async () => {
    // Blockfrost answers a missing project_id this way. Treating 200 as success is exactly how a
    // broken endpoint gets saved and only fails later, inside a sync.
    const fetchImpl = vi.fn(async () => jsonResponse({errors: [{message: 'Missing project token'}]}))
    await expect(
      probeEndpoint('indexer', 'https://i.example.com/graphql', {fetchImpl: fetchImpl as never}),
    ).resolves.toEqual({
      status: 'refused',
      detail: 'Missing project token',
    })
  })

  it('refuses a non-2xx and reports the status', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 403))
    await expect(
      probeEndpoint('indexer', 'https://i.example.com/graphql', {fetchImpl: fetchImpl as never}),
    ).resolves.toEqual({
      status: 'refused',
      detail: 'HTTP 403',
    })
  })

  it('refuses a well-formed answer that is not an indexer', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({data: {}}))
    await expect(
      probeEndpoint('indexer', 'https://i.example.com/graphql', {fetchImpl: fetchImpl as never}),
    ).resolves.toEqual({
      status: 'refused',
      detail: 'no block height in the answer',
    })
  })
})

describe('probeEndpoint — node', () => {
  it('accepts a chain name and reports it', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({jsonrpc: '2.0', id: 1, result: 'Midnight Mainnet'}))
    await expect(probeEndpoint('node', 'https://n.example.com', {fetchImpl: fetchImpl as never})).resolves.toEqual({
      status: 'accepted',
      detail: 'Midnight Mainnet',
    })
  })

  it('refuses an RPC error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({error: {message: 'Method not found'}}))
    await expect(probeEndpoint('node', 'https://n.example.com', {fetchImpl: fetchImpl as never})).resolves.toEqual({
      status: 'refused',
      detail: 'Method not found',
    })
  })
})

describe('probeEndpoint — websocket', () => {
  it('accepts a socket that opens', async () => {
    const stub = socketStub()
    const pending = probeEndpoint('nodeWs', 'wss://n.example.com', {openSocket: stub.open, timeoutMs: 1000})
    await Promise.resolve()
    stub.handlers.onopen?.()
    await expect(pending).resolves.toEqual({status: 'accepted', detail: 'socket opened'})
  })

  it('refuses a socket that errors', async () => {
    const stub = socketStub()
    const pending = probeEndpoint('nodeWs', 'wss://n.example.com', {openSocket: stub.open, timeoutMs: 1000})
    await Promise.resolve()
    stub.handlers.onerror?.()
    await expect(pending).resolves.toEqual({status: 'refused', detail: 'socket refused'})
  })

  it('gives up rather than hanging when nothing answers', async () => {
    const stub = socketStub()
    await expect(
      probeEndpoint('nodeWs', 'wss://n.example.com', {openSocket: stub.open, timeoutMs: 10}),
    ).resolves.toEqual({
      status: 'refused',
      detail: 'timed out',
    })
  })
})

describe('probeEndpoint — failures', () => {
  it('never throws at the caller; a transport failure is a refusal with its reason', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('Network request failed')
    })
    await expect(
      probeEndpoint('indexer', 'https://i.example.com/graphql', {fetchImpl: fetchImpl as never}),
    ).resolves.toEqual({
      status: 'refused',
      detail: 'Network request failed',
    })
  })

  it('does not reach for AbortSignal.timeout, which throws on Hermes before the request is made', async () => {
    // Guards the real defect: the static is absent in Hermes, so a probe built on it reports a
    // failure it never attempted, and every node test still passes.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./endpoint-probe.ts', import.meta.url), 'utf8'),
    )
    // Comments stripped first: the module doc names the trap on purpose, and a guard that fires on
    // its own warning would force the warning out of the file.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/AbortSignal\.(timeout|any)\s*\(/)
    expect(code).toMatch(/new AbortController\(\)/)
  })
})
