import {parse} from '@pnyx/links'
import {Effect} from 'effect'
import {Alert} from 'react-native'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createProvider} from '../i18n'
import type {QrAction} from './qr-parser'

type Router = typeof import('expo-router').router

// Every level, deliberately: a partial mock turns any new log line in the code under test
// into a TypeError, which reads as a logic failure rather than a missing mock.
vi.mock('../logger', () => ({logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}}))

const {handleQrAction} = await import('./qr-actions')
const {claimLinkActionSubject} = await import('../screens/cardano/link-action-handoff')
const {setActiveCardanoNetwork} = await import('../services/cardano/config')
const t = createProvider('en-US').t

function makeRouter(): Router {
  return {navigate: vi.fn()} as unknown as Router
}

const browserLaunchAction = (isSandbox?: boolean): QrAction => ({
  type: 'brandLink',
  raw: 'pnyx://browser/launch?dappUrl=https%3A%2F%2Fexample.com',
  action: {
    feature: 'browser',
    useCase: 'launch',
    params: {dappUrl: 'https://example.com', ...(isSandbox !== undefined && {isSandbox})},
  },
})

describe('handleQrAction — isSandbox guard', () => {
  beforeEach(() => {
    vi.stubGlobal('__DEV__', false)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('ignores sandbox link in production', () => {
    const router = makeRouter()
    const result = handleQrAction(browserLaunchAction(true), router, t)
    expect(result).toBe(false)
    expect(router.navigate).not.toHaveBeenCalled()
  })

  it('allows sandbox link in development', () => {
    vi.stubGlobal('__DEV__', true)
    const router = makeRouter()
    const result = handleQrAction(browserLaunchAction(true), router, t)
    expect(result).toBe(true)
    expect(router.navigate).toHaveBeenCalledWith({pathname: '/browser', params: {url: 'https://example.com'}})
  })

  it('allows non-sandbox link in production', () => {
    const router = makeRouter()
    const result = handleQrAction(browserLaunchAction(false), router, t)
    expect(result).toBe(true)
    expect(router.navigate).toHaveBeenCalled()
  })

  it('allows link without isSandbox in production', () => {
    const router = makeRouter()
    const result = handleQrAction(browserLaunchAction(), router, t)
    expect(result).toBe(true)
    expect(router.navigate).toHaveBeenCalled()
  })
})

describe('handleQrAction — encrypted backup URI', () => {
  it('routes web+cardano://backup?... to the restore-from-backup screen with the raw link', () => {
    const router = makeRouter()
    const raw = 'web+cardano://backup?v=1&enc=abc'
    const action: QrAction = {
      type: 'cardanoUri',
      raw,
      parsed: {authority: 'backup', enc: 'abc', params: {v: '1'}},
    }
    const result = handleQrAction(action, router, t)
    expect(result).toBe(true)
    expect(router.navigate).toHaveBeenCalledWith({
      pathname: '/onboarding/restore-from-backup',
      params: {link: raw},
    })
  })
})

describe('handleQrAction — browse URI (CIP-0158)', () => {
  it('routes browse v1 to the in-app browser', () => {
    const router = makeRouter()
    const raw = `web+cardano://browse/v1?uri=${encodeURIComponent('https://app.example.com/x?y=1')}`
    const action: QrAction = {
      type: 'cardanoUri',
      raw,
      parsed: {authority: 'browse', version: 'v1', uri: 'https://app.example.com/x?y=1'},
    }
    const result = handleQrAction(action, router, t)
    expect(result).toBe(true)
    expect(router.navigate).toHaveBeenCalledWith({
      pathname: '/browser',
      params: {url: 'https://app.example.com/x?y=1'},
    })
  })
})

describe('handleQrAction — payment requests', () => {
  const ADDRESS =
    'addr_test1qr6439dwh0f5jh57y0wkzly5d8upev2z9fnppk4hk7t8smxs4ymglwdxrz6vcajhckc7j8flvsgjskaqq9zzxz2p7r0qckpvwr'

  const request = (over: {chain?: string; amount?: string} = {}): QrAction => ({
    type: 'brandLink',
    raw: 'pnyx://transfer/request/crypto',
    action: {
      feature: 'transfer',
      useCase: 'request/crypto',
      params: {
        chain: over.chain ?? 'cardano:preprod',
        asset: 'ADA',
        address: ADDRESS,
        ...(over.amount === undefined ? {} : {amount: over.amount}),
      },
    },
  })

  beforeEach(() => {
    setActiveCardanoNetwork('preprod')
  })

  it('lands on the chooser rather than acting on the request', () => {
    // Two safety properties at once. A scanned code never acts — and it does not
    // even pick a wallet: the selected one is a leftover from whatever the user was
    // doing, quite possibly a shared or watch-only wallet.
    const router = makeRouter()
    expect(handleQrAction(request({amount: '25000000'}), router, t)).toBe(true)
    expect(router.navigate).toHaveBeenCalledTimes(1)
    const call = (router.navigate as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      pathname: string
      params: {subject: string}
    }
    expect(call.pathname).toBe('/wallet/link-action')
    expect(claimLinkActionSubject(call.params.subject)).toMatchObject({
      kind: 'payment',
      prefill: {addressBech32: ADDRESS, lovelace: 25_000_000n, origin: 'scan'},
    })
  })

  it('accepts a request for the other network — the chooser offers the switch', () => {
    // Refusing here would send the user hunting through settings for something the
    // address itself already said. `networkFitFor` decides on the landing screen.
    const router = makeRouter()
    expect(handleQrAction(request({chain: 'cardano:mainnet', amount: '1'}), router, t)).toBe(true)
    expect(router.navigate).toHaveBeenCalledTimes(1)
  })

  it('names a chain this build cannot send on, rather than alerting "unsupported"', () => {
    // The classifier has described this since the carding pass — an "unsupported"
    // alert here said the app did not understand a link it understands perfectly.
    // It lands and says which chain; what it must not do is offer to pay it.
    const router = makeRouter()
    expect(handleQrAction(request({chain: 'eip155:1', amount: '1'}), router, t)).toBe(true)
    const call = (router.navigate as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      pathname: string
      params: {subject: string}
    }
    expect(call.pathname).toBe('/wallet/link-action')
    expect(claimLinkActionSubject(call.params.subject)).toEqual({
      kind: 'other',
      action: {kind: 'named-only', what: 'otherChain', detail: 'eip155:1'},
    })
  })

  it('routes a CIP-13 pay URI, the standard shape, to the same chooser', () => {
    const router = makeRouter()
    const parsedUri = Effect.runSync(parse(`web+cardano://pay?address=${ADDRESS}&amount=25000000`))
    expect(handleQrAction({type: 'cardanoUri', parsed: parsedUri, raw: 'x'}, router, t)).toBe(true)
    const call = (router.navigate as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      pathname: string
      params: {subject: string}
    }
    expect(call.pathname).toBe('/wallet/link-action')
    expect(claimLinkActionSubject(call.params.subject)).toMatchObject({
      kind: 'payment',
      prefill: {addressBech32: ADDRESS, lovelace: 25_000_000n, origin: 'scan'},
    })
  })

  it('unwraps a nested CIP-13 URI instead of refusing the wrapper', () => {
    // `request/ada-with-link` used to alert "unsupported" while a DM card unwrapped
    // it and paid it — the same string, two answers, depending on how it arrived.
    const router = makeRouter()
    const wrapped: QrAction = {
      type: 'brandLink',
      raw: 'pnyx://transfer/request/ada-with-link',
      action: {
        feature: 'transfer',
        useCase: 'request/ada-with-link',
        params: {link: `web+cardano://pay?address=${ADDRESS}&amount=25000000`},
      },
    }
    expect(handleQrAction(wrapped, router, t)).toBe(true)
    const call = (router.navigate as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      pathname: string
      params: {subject: string}
    }
    expect(claimLinkActionSubject(call.params.subject)).toMatchObject({
      kind: 'payment',
      prefill: {addressBech32: ADDRESS, lovelace: 25_000_000n},
    })
  })

  it('still refuses a wrapper whose inner link is not readable', () => {
    // Refusing what the classifier refuses is the rule that survived; refusing what
    // it describes is the one that did not. Note the inner value is not a link at
    // all — `web+cardano:addr1x` *is* readable (a payment request to a nonsense
    // address, which `resolveRecipient` rejects later, deliberately not here).
    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    const router = makeRouter()
    const broken: QrAction = {
      type: 'brandLink',
      raw: 'pnyx://transfer/request/ada-with-link',
      action: {feature: 'transfer', useCase: 'request/ada-with-link', params: {link: 'not a link at all'}},
    }
    expect(handleQrAction(broken, router, t)).toBe(false)
    expect(router.navigate).not.toHaveBeenCalled()
    expect(alertSpy).toHaveBeenCalled()
  })

  it('names a multi-target transfer request rather than dropping it', () => {
    const router = makeRouter()
    const targets: QrAction = {
      type: 'brandLink',
      raw: 'pnyx://transfer/request/ada',
      action: {
        feature: 'transfer',
        useCase: 'request/ada',
        params: {targets: [{receiver: ADDRESS, amounts: [{tokenId: '', quantity: '1000000'}]}]},
      },
    }
    expect(handleQrAction(targets, router, t)).toBe(true)
    const call = (router.navigate as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      params: {subject: string}
    }
    expect(claimLinkActionSubject(call.params.subject)).toMatchObject({
      kind: 'other',
      action: {kind: 'named-only', what: 'transferTargets'},
    })
  })
})

describe('handleQrAction — the multisig pair, which used to vanish', () => {
  // Both reached `default: return false`, and `deep-link.tsx` turns an unhandled
  // action into `router.replace('/')` — so an invitation to join a shared wallet
  // arrived as a bounce to home with no message at all.
  // A real CIP-5 `acct_shared_xvk` over a 64-byte xpub — `parseCoSignerValue` decodes
  // it for real, so a made-up string would exercise the refusal path by accident.
  const KEY =
    'acct_shared_xvk1qv9pzxqlyckngw6zf9g9whn9d3eh4qvg37tfmf9tk2uup37w6hww86h3lrlsvrg5rv3zjvph8ez5c566v95x7anasj9e9xdq57htt0q57emj0'

  it('lands an invite, named, with nothing to press', () => {
    const router = makeRouter()
    const invite: QrAction = {
      type: 'brandLink',
      raw: 'pnyx://multisig/invite',
      action: {feature: 'multisig', useCase: 'invite', params: {}},
    }
    expect(handleQrAction(invite, router, t)).toBe(true)
    const call = (router.navigate as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      pathname: string
      params: {subject: string}
    }
    expect(call.pathname).toBe('/wallet/link-action')
    expect(claimLinkActionSubject(call.params.subject)).toEqual({
      kind: 'other',
      action: {kind: 'multisig-invite'},
    })
  })

  it('lands a co-signer key, which the sheet can send to the create screen', () => {
    const router = makeRouter()
    // The real link shape, from `buildCoSignerLink` — `readCoSignerKey` reads the
    // whole string, so an abbreviated one silently takes the refusal path instead.
    const raw = `pnyx://pnyx.pxkq.uk/w1/multisig/cosigner-key?key=${KEY}`
    const key: QrAction = {
      type: 'brandLink',
      raw,
      action: {feature: 'multisig', useCase: 'cosigner-key', params: {key: KEY}},
    }
    expect(handleQrAction(key, router, t)).toBe(true)
    const call = (router.navigate as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      params: {subject: string}
    }
    expect(claimLinkActionSubject(call.params.subject)).toMatchObject({
      kind: 'other',
      action: {kind: 'cosigner-key'},
    })
  })

  it('refuses a co-signer key that will not decode', () => {
    // `parseCoSignerValue` reads the raw link, which is why the QR action carries
    // one — a key that cannot be decoded cannot be bound into a spending policy.
    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    const router = makeRouter()
    const bad: QrAction = {
      type: 'brandLink',
      raw: 'pnyx://pnyx.pxkq.uk/w1/multisig/cosigner-key?key=acct_shared_xvk1notakey&name=Bob&accountIndex=0',
      action: {
        feature: 'multisig',
        useCase: 'cosigner-key',
        params: {key: 'acct_shared_xvk1notakey', name: 'Bob', accountIndex: 0},
      },
    }
    expect(handleQrAction(bad, router, t)).toBe(false)
    expect(router.navigate).not.toHaveBeenCalled()
    expect(alertSpy).toHaveBeenCalled()
  })
})

describe('handleQrAction — a bare Cardano address', () => {
  const ADDRESS =
    'addr_test1qr6439dwh0f5jh57y0wkzly5d8upev2z9fnppk4hk7t8smxs4ymglwdxrz6vcajhckc7j8flvsgjskaqq9zzxz2p7r0qckpvwr'

  beforeEach(() => {
    setActiveCardanoNetwork('preprod')
  })

  it('is an open payment request, the same reading web+cardano://address gets', () => {
    // This branch alerted "address payloads are unsupported (no funds features)",
    // which stopped being true at the multi-chain pivot — and meant a bare address
    // and the URI wrapping the same address behaved differently.
    const router = makeRouter()
    expect(handleQrAction({type: 'address', address: ADDRESS, network: 'testnet'}, router, t)).toBe(true)
    const call = (router.navigate as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      pathname: string
      params: {subject: string}
    }
    expect(call.pathname).toBe('/wallet/link-action')
    expect(claimLinkActionSubject(call.params.subject)).toMatchObject({
      kind: 'payment',
      prefill: {addressBech32: ADDRESS, lovelace: null},
    })
  })
})

describe('handleQrAction — a deep link never acts on arrival', () => {
  const BACKUP = 'web+cardano://backup?enc=eyJhIjoxfQ'
  const BROWSE = 'web+cardano://browse/v1?uri=https%3A%2F%2Fexample.com'

  const scan = (uri: string): QrAction => ({type: 'cardanoUri', parsed: Effect.runSync(parse(uri)), raw: uri})
  const landedOn = (router: Router) =>
    (router.navigate as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      pathname: string
      params: {subject?: string; link?: string; url?: string}
    }

  it('lands an external backup on the sheet instead of the restore flow', () => {
    // The sharp one. Restoring a stranger's backup installs their wallet on this
    // device, so an external URL must never be able to start it.
    const router = makeRouter()
    expect(handleQrAction(scan(BACKUP), router, t, {source: 'deep-link'})).toBe(true)
    expect(landedOn(router).pathname).toBe('/wallet/link-action')
  })

  it('still restores a *scanned* backup, which came from the user', () => {
    const router = makeRouter()
    expect(handleQrAction(scan(BACKUP), router, t, {source: 'scan'})).toBe(true)
    expect(landedOn(router).pathname).toBe('/onboarding/restore-from-backup')
  })

  it('lands an external browse link instead of opening the browser', () => {
    const router = makeRouter()
    expect(handleQrAction(scan(BROWSE), router, t, {source: 'deep-link'})).toBe(true)
    expect(landedOn(router).pathname).toBe('/wallet/link-action')
  })

  it('still opens a *scanned* browse link directly', () => {
    const router = makeRouter()
    expect(handleQrAction(scan(BROWSE), router, t, {source: 'scan'})).toBe(true)
    expect(landedOn(router).pathname).toBe('/browser')
  })

  it('lands a plain external URL, and refuses one with no host', () => {
    const router = makeRouter()
    expect(handleQrAction({type: 'url', url: 'https://example.com/x'}, router, t, {source: 'deep-link'})).toBe(true)
    expect(landedOn(router).pathname).toBe('/wallet/link-action')
  })
})

describe('handleQrAction — delegation links', () => {
  const POOL_ID = 'pool1qv9pzxqlyckngw6zf9g9whn9d3eh4qvg37tfmf9tk2uuqh3rx6y'
  const DREP_ID = 'drep1ygqxv0cqcnqu56akgpwx3dwrqq363kx876ktavrt059y6tq44crgz'

  const scan = (uri: string): QrAction => ({
    type: 'cardanoUri',
    parsed: Effect.runSync(parse(uri)),
    // Deliberately not the URI: the router must read the parse the scanner already
    // did rather than re-parsing this string.
    raw: 'x',
  })

  const navigated = (router: Router) =>
    (router.navigate as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      pathname: string
      params: {subject: string}
    }

  it('routes a scanned pool delegation to the chooser, not the staking screen', () => {
    // Same reason a payment lands there: whose stake account is the open question,
    // and a scanned code never answers it.
    const router = makeRouter()
    expect(handleQrAction(scan(`web+cardano://stake?poolId=${POOL_ID}`), router, t)).toBe(true)
    const call = navigated(router)
    expect(call.pathname).toBe('/wallet/link-action')
    expect(claimLinkActionSubject(call.params.subject)).toMatchObject({
      kind: 'delegation',
      poolId: POOL_ID,
      prefill: {poolId: POOL_ID, drep: null, origin: 'scan'},
    })
  })

  it('routes a scanned DRep delegation, canonicalising the target', () => {
    const router = makeRouter()
    expect(handleQrAction(scan(`web+cardano://drep?drepId=${DREP_ID}`), router, t)).toBe(true)
    const subject = claimLinkActionSubject(navigated(router).params.subject)
    expect(subject).toMatchObject({kind: 'delegation', drepId: DREP_ID})
    expect(subject).toMatchObject({prefill: {drep: {kind: 'key'}}})
  })

  it('refuses a scanned target that could never be delegated to', () => {
    // The classifier decides, so a QR and a card in a thread cannot disagree about
    // the same string. Opening a delegation screen for an id no certificate can be
    // built from would be an offer that fails after the tap.
    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    const router = makeRouter()
    expect(handleQrAction(scan('web+cardano://stake?poolId=pool1abc'), router, t)).toBe(false)
    expect(router.navigate).not.toHaveBeenCalled()
    expect(alertSpy).toHaveBeenCalled()
  })
})

describe('handleQrAction — a scanned pnyx_id', () => {
  const PNYX_ID = 'pnyx_id1qv9pzxqlyckngw6zf9g9whn9d3eh4qvg37tfmf9tk2uup37w6hwqk8jmw3'

  beforeEach(() => {
    vi.spyOn(Alert, 'alert').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens the new-conversation screen with the id already filled in', () => {
    const router = makeRouter()
    expect(handleQrAction({type: 'pnyxId', pnyxId: PNYX_ID}, router, t)).toBe(true)
    expect(router.navigate).toHaveBeenCalledWith({pathname: '/dm/new', params: {peer: PNYX_ID}})
  })

  it('does not start the conversation itself, nor alert', () => {
    // `/dm/new` seeds the field and waits for a tap — that screen *is* the confirmation, which is why
    // this one shape needs no link-action sheet.
    const router = makeRouter()
    handleQrAction({type: 'pnyxId', pnyxId: PNYX_ID}, router, t)
    expect(Alert.alert).not.toHaveBeenCalled()
    expect(router.navigate).toHaveBeenCalledTimes(1)
  })

  it('lands the same way when it arrives from a deep link', () => {
    // A bare id is not a URI so it cannot arrive as one today; asserted so that if some path ever
    // feeds one in, the behaviour is a decision on record rather than an accident.
    const router = makeRouter()
    expect(handleQrAction({type: 'pnyxId', pnyxId: PNYX_ID}, router, t, {source: 'deep-link'})).toBe(true)
    expect(router.navigate).toHaveBeenCalledWith({pathname: '/dm/new', params: {peer: PNYX_ID}})
  })
})
