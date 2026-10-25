import {afterEach, describe, expect, it, vi} from 'vitest'
import {createBridgeTransport} from './bridge-transport'
import {bytesToHex, writeUint16BE, writeUint32BE} from './bytes'
import messagesJson from './messages.json' with {type: 'json'}
import {encodeMessage, parseConfigure} from './protobuf'

describe('createBridgeTransport', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('POSTs /enumerate with default base URL and parses descriptors', async () => {
    const descriptors = [
      {
        path: 'emulator:1',
        vendor: 21324,
        product: 1,
        session: null,
        debug: true,
        debugSession: null,
      },
    ]
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('http://127.0.0.1:21328/enumerate')
      return new Response(JSON.stringify(descriptors), {status: 200})
    })
    globalThis.fetch = fetchMock as typeof fetch

    const bridge = createBridgeTransport({})
    const list = await bridge.enumerate()

    expect(list).toEqual(descriptors)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:21328/enumerate',
      expect.objectContaining({
        method: 'POST',
        headers: {Origin: 'https://wallet.trezor.io'},
      }),
    )
  })

  it('uses custom url from config', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('http://bridge.test:9999/enumerate')
      return new Response('[]', {status: 200})
    })
    globalThis.fetch = fetchMock as typeof fetch

    await createBridgeTransport({url: 'http://bridge.test:9999'}).enumerate()

    expect(fetchMock).toHaveBeenCalled()
  })

  it('acquire returns session on HTTP 200', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/acquire/emulator:1/null')) {
        return new Response(JSON.stringify({session: 'sess-1'}), {status: 200})
      }
      return new Response('{}', {status: 404})
    })
    globalThis.fetch = fetchMock as typeof fetch

    const bridge = createBridgeTransport({})
    const result = await bridge.acquire({input: {path: 'emulator:1', previous: null}})

    expect(result).toEqual({success: true, payload: 'sess-1'})
  })

  it('acquire returns failure when bridge returns non-200', async () => {
    globalThis.fetch = vi.fn(async () => new Response('busy', {status: 409})) as typeof fetch

    const bridge = createBridgeTransport({})
    const result = await bridge.acquire({input: {path: 'x', previous: 'prev'}})

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('AcquireFailed')
      expect(result.message).toContain('409')
    }
  })

  it('acquire recovers from "wrong previous session" by re-enumerating and retrying', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      // First attempt with stale `previous` is rejected by the bridge.
      if (url.endsWith('/acquire/emulator:1/null')) {
        return new Response(JSON.stringify({error: 'wrong previous session'}), {status: 400})
      }
      // Re-enumerate reveals the device's actual current session.
      if (url.endsWith('/enumerate')) {
        return new Response(
          JSON.stringify([
            {path: 'emulator:1', vendor: 1, product: 1, session: 'stale-7', debug: false, debugSession: null},
          ]),
          {status: 200},
        )
      }
      // Retry with the real session succeeds.
      if (url.endsWith('/acquire/emulator:1/stale-7')) {
        return new Response(JSON.stringify({session: 'sess-2'}), {status: 200})
      }
      return new Response('{}', {status: 404})
    })
    globalThis.fetch = fetchMock as typeof fetch

    const bridge = createBridgeTransport({})
    const result = await bridge.acquire({input: {path: 'emulator:1', previous: null}})

    expect(result).toEqual({success: true, payload: 'sess-2'})
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:21328/enumerate', expect.anything())
  })

  it('acquire surfaces the 400 when no matching device is found on re-enumerate', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/enumerate')) return new Response('[]', {status: 200})
      return new Response(JSON.stringify({error: 'wrong previous session'}), {status: 400})
    }) as typeof fetch

    const bridge = createBridgeTransport({})
    const result = await bridge.acquire({input: {path: 'emulator:1', previous: null}})

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('AcquireFailed')
      expect(result.message).toContain('wrong previous session')
    }
  })

  it('release returns success on HTTP 200', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/release/sess-a')
      return new Response('', {status: 200})
    }) as typeof fetch

    const bridge = createBridgeTransport({})
    const result = await bridge.release({path: 'p', session: 'sess-a'})

    expect(result).toEqual({success: true, payload: undefined})
  })

  it('forwards external AbortSignal to fetch and completes when already aborted', async () => {
    const fetchMock = vi.fn(async (_input, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(true)
      throw new DOMException('Aborted', 'AbortError')
    })
    globalThis.fetch = fetchMock as typeof fetch

    const bridge = createBridgeTransport({timeout: 60_000})
    const controller = new AbortController()
    controller.abort()

    const result = await bridge.acquire({input: {path: 'p', previous: null}, signal: controller.signal})

    expect(result.success).toBe(false)
    expect(fetchMock).toHaveBeenCalled()
  })

  it('updateMessages swaps protobuf definitions', async () => {
    globalThis.fetch = vi.fn(async () => new Response('[]', {status: 200})) as typeof fetch

    const bridge = createBridgeTransport({})
    const msgs = {nested: {Message: {fields: {x: {type: 'string', id: 1}}}}}
    bridge.updateMessages(msgs)
    await expect(bridge.enumerate()).resolves.toEqual([])
  })

  it('call returns decoded message when bridge returns 200 with hex payload', async () => {
    const messages = parseConfigure(messagesJson as import('protobufjs').INamespace)
    const encoded = encodeMessage(messages, 'Success', {message: 'done'})
    const frame = new Uint8Array(6 + encoded.message.length)
    writeUint16BE(frame, encoded.messageType, 0)
    writeUint32BE(frame, encoded.message.length, 2)
    frame.set(encoded.message, 6)
    const hexResponse = bytesToHex(frame)

    let sentBody: string | undefined
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/call/')) {
        sentBody = init?.body as string
        // node-bridge wraps the response as a BridgeProtocolMessage JSON envelope
        return new Response(JSON.stringify({protocol: 'bridge', data: hexResponse}), {status: 200})
      }
      return new Response('[]', {status: 200})
    }) as typeof fetch

    const bridge = createBridgeTransport({})
    const result = await bridge.call({session: 'sess', name: 'GetFeatures', data: {}})

    // Request is the JSON envelope with the bare bridge-framed hex, not raw hex
    expect(JSON.parse(sentBody as string)).toMatchObject({protocol: 'bridge', data: expect.any(String)})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.payload.type).toBe('Success')
      expect(result.payload.message).toEqual({message: 'done'})
    }
  })

  it('call returns failure when bridge returns non-200', async () => {
    globalThis.fetch = vi.fn(async () => new Response('err', {status: 500})) as typeof fetch

    const bridge = createBridgeTransport({})
    const result = await bridge.call({session: 'sess', name: 'GetFeatures', data: {}})

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('CallFailed')
      expect(result.message).toContain('500')
    }
  })

  it('call returns failure when encode or network throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down')
    }) as typeof fetch

    const bridge = createBridgeTransport({})
    const result = await bridge.call({session: 'sess', name: 'GetFeatures', data: {}})

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('CallFailed')
      expect(result.message).toContain('network down')
    }
  })

  it('release returns failure when bridge returns non-200', async () => {
    globalThis.fetch = vi.fn(async () => new Response('no', {status: 400})) as typeof fetch

    const bridge = createBridgeTransport({})
    const result = await bridge.release({path: 'p', session: 'sess-b'})

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('ReleaseFailed')
    }
  })

  it('release returns failure on network error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('econnrefused')
    }) as typeof fetch

    const bridge = createBridgeTransport({})
    const result = await bridge.release({path: 'p', session: 'sess-c'})

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('ReleaseFailed')
      expect(result.message).toContain('econnrefused')
    }
  })

  it('loadMessages delegates to protobuf loadDefinitions', async () => {
    globalThis.fetch = vi.fn(async () => new Response('[]', {status: 200})) as typeof fetch

    const bridge = createBridgeTransport({})
    await expect(
      bridge.loadMessages('hw.trezor.messages.management', () => {
        return {nested: {}} as import('protobufjs').INamespace
      }),
    ).resolves.toBeUndefined()
  })
})
