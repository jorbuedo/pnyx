import {beforeEach, describe, expect, it, vi} from 'vitest'

const {state} = vi.hoisted(() => ({
  state: {
    params: {} as Record<string, string | string[] | undefined>,
    router: {
      replace: vi.fn(),
    },
    t: vi.fn((key: string) => key),
    options: {
      onCryptoTransferPaymentRequest: vi.fn(),
    },
    handleQrAction: vi.fn<(...args: unknown[]) => boolean>(() => true),
  },
}))

vi.mock('react', () => ({
  useEffect: (effect: () => void) => effect(),
  useRef: (initial: unknown) => ({current: initial}),
}))

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => state.params,
  useRouter: () => state.router,
}))

vi.mock('./brand', () => ({
  brand: {scheme: 'pnyx'},
}))

vi.mock('./hooks/deep-link-options', () => ({
  useDeepLinkOptions: () => state.options,
}))

vi.mock('./logger', () => ({
  logger: {
    warn: vi.fn(),
  },
}))

vi.mock('./providers/I18nProvider', () => ({
  useI18n: () => ({t: state.t}),
}))

vi.mock('./utils/qr-actions', () => ({
  handleQrAction: (...args: unknown[]) => state.handleQrAction(...args),
}))

const {default: DeepLinkRoute} = await import('../app/deep-link')

const renderRoute = () => DeepLinkRoute()

describe('DeepLinkRoute', () => {
  beforeEach(() => {
    state.params = {}
    state.router.replace.mockClear()
    state.t.mockClear()
    state.options.onCryptoTransferPaymentRequest.mockClear()
    state.handleQrAction.mockClear()
    state.handleQrAction.mockReturnValue(true)
  })

  it('returns home when no url param is present', () => {
    renderRoute()

    expect(state.router.replace).toHaveBeenCalledWith('/')
    expect(state.handleQrAction).not.toHaveBeenCalled()
  })

  it('does not convert arbitrary native brand-scheme URLs into app routes', () => {
    state.params = {url: 'pnyx://settings/security'}

    renderRoute()

    expect(state.router.replace).toHaveBeenCalledWith('/')
    expect(state.handleQrAction).not.toHaveBeenCalled()
  })

  it('dispatches partner brand links through the QR action pipeline', () => {
    state.params = {
      url: 'pnyx://pnyx.pxkq.uk/w1/transfer/request/crypto?client=encryptus&chain=ETHEREUM&name=USDC&address=0x742d35Cc6634C0532925a3b844Bc454e4438f44e&amount=5050000',
    }

    renderRoute()

    expect(state.handleQrAction).toHaveBeenCalledOnce()
    const [action, router, t, options] = state.handleQrAction.mock.calls[0] ?? []
    expect(action).toEqual(
      expect.objectContaining({
        type: 'brandLink',
        action: expect.objectContaining({
          feature: 'transfer',
          useCase: 'request/crypto',
        }),
      }),
    )
    expect(router).toBe(state.router)
    expect(t).toBe(state.t)
    expect(options).toBe(state.options)
    expect(state.router.replace).toHaveBeenCalledWith('/')
  })

  it('preserves nested redirectTo query params in partner brand links', () => {
    const redirectTo = 'https://hub.encryptus.co/pw/?orderId=1&status=done'
    state.params = {
      url: `pnyx://pnyx.pxkq.uk/w1/transfer/request/crypto?client=encryptus&chain=ETHEREUM&name=USDC&address=0x742d35Cc6634C0532925a3b844Bc454e4438f44e&amount=5050000&redirectTo=${encodeURIComponent(
        redirectTo,
      )}`,
    }

    renderRoute()

    const [action] = state.handleQrAction.mock.calls[0] ?? []
    expect(action).toEqual(
      expect.objectContaining({
        type: 'brandLink',
        action: expect.objectContaining({
          params: expect.objectContaining({redirectTo}),
        }),
      }),
    )
  })

  it('repairs web schemes whose plus sign was decoded as a space', () => {
    state.params = {url: 'web cardano://pay?address=addr1qx2fxv2u&amount=1000000'}

    renderRoute()

    expect(state.handleQrAction).toHaveBeenCalledOnce()
    const [action] = state.handleQrAction.mock.calls[0] ?? []
    expect(action).toEqual(
      expect.objectContaining({
        type: 'cardanoUri',
        parsed: expect.objectContaining({authority: 'pay'}),
      }),
    )
  })
})
