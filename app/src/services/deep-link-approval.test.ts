import {describe, expect, it} from 'vitest'

import {approveSystemPath} from './deep-link-approval'

const decide = (path: string, allowDevRoutes = false) => approveSystemPath({path, brandScheme: 'pnyx', allowDevRoutes})

describe('approved shapes', () => {
  // ⚠️ These used to be rewritten to `/ramp/…` and routed. That was never reachable — `app/ramp/` went
  // at the shell pivot — and nothing here knows about a ramp any more: a brand-host URL is treated as
  // any other brand link, so it reaches the sheet and the classifier refuses the payload there.
  it('treats a former ramp callback on a brand host as an ordinary brand link', () => {
    expect(decide('https://pnyx.pxkq.uk/ramp/order?orderId=order-123')).toEqual({kind: 'dispatch'})
  })

  it('denies one on any other host, like every unapproved path', () => {
    expect(decide('pnyx://ramp/sell/result?status=failed').kind).toBe('deny')
  })

  // These reach `/wallet/link-action`, which asks which wallet to act with. The decision here only
  // keeps Expo Router from trying to resolve the raw URL as a route.
  it.each([
    'web+cardano://pay/v1?address=addr1...&amount=1.5',
    'web+cardano://browse/v1?uri=https%3A%2F%2Fapp.example.com',
    'pnyx://pnyx.pxkq.uk/w1/transfer/request/crypto?chain=ETHEREUM&address=0xabc',
    'https://pnyx.pxkq.uk/w1/browser/launch?dappUrl=https%3A%2F%2Fapp.example.com',
  ])('hands %s to the in-app dispatcher', (link) => {
    expect(decide(link)).toEqual({kind: 'dispatch'})
  })
})

describe('everything else is denied', () => {
  // ⚠️ The reason this module exists. Each of these landed on its screen before, chosen by the link:
  // the review one arrived pre-filled with a recipient and an amount, one press from a send.
  it.each([
    'pnyx:///wallet/midnight/review?to=mn_addr_preprod1abc&rail=unshielded&amount=100000000',
    'pnyx:///browser?url=https://example.com',
    'pnyx:///wallet/dust',
    'pnyx:///settings/wallet-selection',
    'pnyx://send',
    '/wallet',
  ])('denies %s', (link) => {
    expect(decide(link).kind).toBe('deny')
  })

  it('names what it refused, so the log says which link was dropped', () => {
    const decision = decide('pnyx:///wallet/midnight/review?to=mn_addr_preprod1abc&amount=1')
    expect(decision.kind === 'deny' && decision.reason).toContain('/wallet/midnight/review')
  })

  it('denies an empty path rather than treating it as the root', () => {
    expect(decide('   ').kind).toBe('deny')
  })
})

describe('the dev-tools exception', () => {
  // The committed probe screens, documented in `docs/DIRECT_MESSAGES_PLAN.md` as a link.
  it('routes a dev-tools path in a dev build', () => {
    expect(decide('pnyx:///settings/dev/mls-probe', true)).toEqual({
      kind: 'route',
      path: 'pnyx:///settings/dev/mls-probe',
    })
  })

  // The whole point of gating it: a shipped build has no link-reachable dev screens.
  it('denies the same path when dev routes are off', () => {
    expect(decide('pnyx:///settings/dev/mls-probe', false).kind).toBe('deny')
  })

  // ⚠️ The exception is a prefix, not "anything in a dev build" — a dev build must not re-open the
  // hole this module closed. `/wallet/midnight/review` stays denied with the flag on.
  it('does not widen to other routes in a dev build', () => {
    expect(decide('pnyx:///wallet/midnight/review?to=mn_addr_preprod1abc&amount=1', true).kind).toBe('deny')
    expect(decide('pnyx:///browser?url=https://example.com', true).kind).toBe('deny')
  })

  // Two slashes puts `settings` in the authority, so the pathname is `/dev/…`. That form never landed;
  // it stays denied rather than being quietly repaired into the three-slash one.
  it('denies the two-slash form even in a dev build', () => {
    expect(decide('pnyx://settings/dev/mls-probe', true).kind).toBe('deny')
  })
})

describe('a bare scheme is no link at all', () => {
  // ⚠️ What a cold launch from the launcher icon hands over. It used to be reported as a refused
  // link — a warning on every single start, which is how the one that matters gets skipped.
  it.each(['pnyx://', 'pnyx:///', '  pnyx:///  '])('reports no-link for %s', (link) => {
    expect(decide(link).kind).toBe('no-link')
  })

  it('still denies a scheme with something after it', () => {
    // `pnyx://send` has an empty pathname too, because `send` is the authority — that is a link
    // somebody sent, and it must not be waved through as an empty launch.
    expect(decide('pnyx://send').kind).toBe('deny')
    expect(decide('pnyx:///?to=someone').kind).toBe('deny')
  })
})
