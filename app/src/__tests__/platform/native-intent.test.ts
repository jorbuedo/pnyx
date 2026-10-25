import {describe, expect, it, vi} from 'vitest'

vi.mock('@sentry/react-native', () => ({
  init: vi.fn(),
}))

vi.mock('../../../src/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import {redirectSystemPath} from '../../../app/+native-intent'

describe('+native-intent', () => {
  // Cold-start brand-scheme deep links arrive here before useDeepLinkHandler
  // mounts. Returning the raw URL makes Expo Router land on +not-found.
  // Route to `/`; the in-app listener picks the URL up via Linking.getInitialURL.
  it.each([
    'web+cardano://browse/v1?uri=https%3A%2F%2Fapp.example.com',
    'web+cardano://pay/v1?address=addr1...&amount=1.5',
    'pnyx://pnyx.pxkq.uk/w1/transfer/request/crypto?chain=ETHEREUM&address=0xabc',
    'pnyx://pnyx.pxkq.uk/w1/exchange/show/result?provider=encryptus',
    'https://pnyx.pxkq.uk/w1/transfer/request/crypto?chain=ETHEREUM&address=0xabc',
    'https://pnyx.pxkq.uk/w1/browser/launch?dappUrl=https%3A%2F%2Fapp.example.com',
  ])('routes brand-scheme deep link %s to /', (link) => {
    expect(redirectSystemPath({path: link, initial: true})).toBe('/')
  })

  // ⚠️ These used to be rewritten to `/ramp/…`, a route removed at the shell pivot. Nothing knows about
  // a ramp now: on a brand host they are brand links and reach the sheet, anywhere else they are denied.
  it('no longer rewrites former ramp callbacks to a route', () => {
    expect(redirectSystemPath({path: 'https://pnyx.pxkq.uk/ramp/order?orderId=order-123', initial: true})).toBe('/')
    expect(redirectSystemPath({path: 'pnyx://ramp/buy/result?status=failed', initial: true})).toBeNull()
  })

  // ⚠️ These used to pass through, which let any link pick any screen — the rule and the case that
  // motivated it are in `src/services/deep-link-approval.ts`. `null` is expo-router's "navigate
  // nowhere", so the app opens where it would have opened.
  it('refuses a path that is not an approved route', () => {
    expect(redirectSystemPath({path: 'pnyx://send', initial: true})).toBeNull()
    expect(redirectSystemPath({path: '/wallet', initial: true})).toBeNull()
    expect(
      redirectSystemPath({path: 'pnyx:///wallet/midnight/review?to=mn_addr_preprod1abc&amount=1', initial: true}),
    ).toBeNull()
  })

  // `__DEV__` is true under vitest (`setup-asset-mocks.ts`), so this asserts the dev branch: the
  // documented probe links keep working while nothing else does, even here.
  it('allows the dev-tools prefix in a dev build and nothing beside it', () => {
    expect(redirectSystemPath({path: 'pnyx:///settings/dev/mls-probe', initial: true})).toBe(
      'pnyx:///settings/dev/mls-probe',
    )
    expect(redirectSystemPath({path: 'pnyx:///settings/wallet-selection', initial: true})).toBeNull()
  })
})
