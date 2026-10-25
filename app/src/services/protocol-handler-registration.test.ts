import {afterEach, describe, expect, it, vi} from 'vitest'

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
}

vi.mock('../brand', () => ({
  brand: {displayName: 'Pnyx', scheme: 'pnyx'},
}))

vi.mock('../logger', () => ({
  logger,
}))

async function loadService(platform: {
  readonly platformIsWeb: boolean
  readonly isExtensionDevIframe: boolean
  readonly isExtensionSidePanel?: boolean
}) {
  vi.doMock('../platform', () => ({isExtensionSidePanel: false, ...platform}))
  return import('./protocol-handler-registration')
}

const createLocalStorage = () => {
  const values = new Map<string, string>()

  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
    clear: vi.fn(() => values.clear()),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    get length() {
      return values.size
    },
  } as unknown as Storage
}

const stubWindowProtocol = (protocol: string, localStorage?: Storage) => {
  vi.stubGlobal('window', {location: {protocol}, ...(localStorage ? {localStorage} : {})})
}

describe('protocol-handler-registration', () => {
  afterEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('reports unavailable outside web', async () => {
    const service = await loadService({platformIsWeb: false, isExtensionDevIframe: false})

    expect(service.getPnyxProtocolHandlerAvailability()).toBe('not-web')
    expect(service.registerPnyxProtocolHandler()).toEqual({ok: false, reason: 'not-web'})
  })

  it('reports unavailable from non-extension insecure web origins', async () => {
    stubWindowProtocol('http:')
    vi.stubGlobal('navigator', {registerProtocolHandler: vi.fn()})
    const service = await loadService({platformIsWeb: true, isExtensionDevIframe: false})

    expect(service.canRegisterPnyxProtocolHandler()).toBe(false)
    expect(service.getPnyxProtocolHandlerAvailability()).toBe('unsupported-origin')
    expect(service.registerPnyxProtocolHandler()).toEqual({ok: false, reason: 'unsupported-origin'})
  })

  it('allows secure web origins', async () => {
    stubWindowProtocol('https:')
    vi.stubGlobal('navigator', {registerProtocolHandler: vi.fn(), unregisterProtocolHandler: vi.fn()})
    const service = await loadService({platformIsWeb: true, isExtensionDevIframe: false})

    expect(service.canRegisterPnyxProtocolHandler()).toBe(true)
    expect(service.getPnyxProtocolHandlerAvailability()).toBe('available')
  })

  it('does not register from the dev iframe', async () => {
    stubWindowProtocol('http:')
    const service = await loadService({platformIsWeb: true, isExtensionDevIframe: true})

    expect(service.getPnyxProtocolHandlerAvailability()).toBe('dev-iframe')
    expect(service.registerPnyxProtocolHandler()).toEqual({ok: false, reason: 'dev-iframe'})
  })

  it('does not register directly from the extension side panel', async () => {
    stubWindowProtocol('chrome-extension:')
    vi.stubGlobal('navigator', {registerProtocolHandler: vi.fn()})
    const service = await loadService({
      platformIsWeb: true,
      isExtensionDevIframe: false,
      isExtensionSidePanel: true,
    })

    expect(service.canRegisterPnyxProtocolHandler()).toBe(true)
    expect(service.getPnyxProtocolHandlerAvailability()).toBe('side-panel')
    expect(service.registerPnyxProtocolHandler()).toEqual({ok: false, reason: 'side-panel'})
  })

  it('reports unavailable when the browser API is missing', async () => {
    stubWindowProtocol('chrome-extension:')
    vi.stubGlobal('navigator', {})
    const service = await loadService({platformIsWeb: true, isExtensionDevIframe: false})

    expect(service.getPnyxProtocolHandlerAvailability()).toBe('missing-api')
    expect(service.registerPnyxProtocolHandler()).toEqual({ok: false, reason: 'missing-api'})
  })

  it('unregisters and registers the Pnyx and Cardano protocol handlers', async () => {
    const unregisterProtocolHandler = vi.fn()
    const registerProtocolHandler = vi.fn()
    const localStorage = createLocalStorage()
    stubWindowProtocol('chrome-extension:', localStorage)
    vi.stubGlobal('navigator', {registerProtocolHandler, unregisterProtocolHandler})
    const service = await loadService({platformIsWeb: true, isExtensionDevIframe: false})

    expect(service.hasRequestedPnyxProtocolHandlerRegistration()).toBe(false)
    expect(service.registerPnyxProtocolHandler()).toEqual({ok: true})
    expect(service.hasRequestedPnyxProtocolHandlerRegistration()).toBe(true)
    expect(localStorage.setItem).toHaveBeenCalledWith(service.PNYX_PROTOCOL_HANDLER_REGISTRATION_REQUESTED_KEY, 'true')
    expect(unregisterProtocolHandler).toHaveBeenCalledWith('web+pnyx', 'index.html#/deep-link?url=%s')
    expect(unregisterProtocolHandler).toHaveBeenCalledWith('web+cardano', 'index.html#/deep-link?url=%s')
    expect(registerProtocolHandler).toHaveBeenCalledWith('web+pnyx', 'index.html#/deep-link?url=%s', 'Pnyx')
    expect(registerProtocolHandler).toHaveBeenCalledWith('web+cardano', 'index.html#/deep-link?url=%s', 'Pnyx')
    expect(logger.info).toHaveBeenCalledWith(
      'Protocol handler registration requested',
      expect.objectContaining({scheme: 'web+pnyx'}),
    )
    expect(logger.info).toHaveBeenCalledWith(
      'Protocol handler registration requested',
      expect.objectContaining({scheme: 'web+cardano'}),
    )
  })

  it('continues registration when unregister throws', async () => {
    const unregisterError = new Error('not registered')
    const unregisterProtocolHandler = vi.fn(() => {
      throw unregisterError
    })
    const registerProtocolHandler = vi.fn()
    stubWindowProtocol('chrome-extension:')
    vi.stubGlobal('navigator', {registerProtocolHandler, unregisterProtocolHandler})
    const service = await loadService({platformIsWeb: true, isExtensionDevIframe: false})

    expect(service.registerPnyxProtocolHandler()).toEqual({ok: true})
    expect(registerProtocolHandler).toHaveBeenCalledWith('web+pnyx', 'index.html#/deep-link?url=%s', 'Pnyx')
    expect(registerProtocolHandler).toHaveBeenCalledWith('web+cardano', 'index.html#/deep-link?url=%s', 'Pnyx')
    expect(logger.warn).toHaveBeenCalledWith(
      'Protocol handler unregister failed before registering again',
      expect.objectContaining({error: `Error: ${unregisterError.message}`}),
    )
  })

  it('returns a failed result when registration throws', async () => {
    const error = new Error('blocked')
    const localStorage = createLocalStorage()
    stubWindowProtocol('chrome-extension:', localStorage)
    const registerProtocolHandler = vi.fn((scheme: string) => {
      if (scheme === 'web+cardano') throw error
    })
    vi.stubGlobal('navigator', {registerProtocolHandler, unregisterProtocolHandler: vi.fn()})
    const service = await loadService({platformIsWeb: true, isExtensionDevIframe: false})

    expect(service.registerPnyxProtocolHandler()).toEqual({ok: false, reason: 'failed', error})
    expect(service.hasRequestedPnyxProtocolHandlerRegistration()).toBe(false)
    expect(localStorage.setItem).not.toHaveBeenCalled()
    expect(registerProtocolHandler).toHaveBeenCalledWith('web+pnyx', 'index.html#/deep-link?url=%s', 'Pnyx')
    expect(registerProtocolHandler).toHaveBeenCalledWith('web+cardano', 'index.html#/deep-link?url=%s', 'Pnyx')
    expect(logger.warn).toHaveBeenCalledWith(
      'Protocol handler registration failed',
      expect.objectContaining({error: `Error: ${error.message}`, scheme: 'web+cardano'}),
    )
  })
})
