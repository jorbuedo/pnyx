import {Cip129} from '@evolution-sdk/cips'
import {XpubHex} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {bech32} from '@pnyx/crypto'
import {buildBrandLink, PNYX_SCHEME} from '@pnyx/links'
import {Either} from 'effect'
import {describe, expect, it} from 'vitest'
import {buildFundsRequest} from './cardano/funds-request'
import {buildCoSignerLink} from './cardano/multisig/cosigner-invite'
import {buildDefinitionLink} from './cardano/multisig/definition-link'
import {hexToBytes} from './cardano-pool-drep/http'
import {readLinkAction} from './link-action'

const ADDRESS =
  'addr_test1qr6439dwh0f5jh57y0wkzly5d8upev2z9fnppk4hk7t8smxs4ymglwdxrz6vcajhckc7j8flvsgjskaqq9zzxz2p7r0qckpvwr'

/** 64 bytes: an account xpub is a 32-byte public key followed by its chain code. */
const XPUB_HEX = 'ab'.repeat(32) + 'cd'.repeat(32)

/** A real `pool1…` over a 28-byte key hash — the classifier decodes it now. */
const POOL_HASH = new Uint8Array(28).map((_, i) => (i * 7 + 3) & 0xff)
const POOL_ID = bech32.encode('pool', bech32.toWords(POOL_HASH), 1023)

/** One DRep credential in both of its spellings. */
const DREP_HASH_HEX = 'a5b45515a3ff8cb7c02ce351834da324eb6dfc41b5779cb5e6b832aa'
const DREP_HASH = hexToBytes(DREP_HASH_HEX)
const DREP_CIP105_ID = bech32.encode('drep', bech32.toWords(DREP_HASH), 1023)
const DREP_CIP129_ID = Cip129.drepBech32(DREP_HASH, false)
const DREP_TARGET = {kind: 'key', hashHex: DREP_HASH_HEX} as const

describe('readLinkAction', () => {
  it('is null for ordinary conversation', () => {
    // The common answer, and the reason nothing here is a heuristic: text that is
    // not one of these *is* chat.
    for (const text of ['hello', 'see https://example.com', '', '   ', 'pnyx://', 'addr_test1abc']) {
      expect(readLinkAction(text)).toBeNull()
    }
  })

  it('is null for a foreign scheme, so another app link is never a card', () => {
    expect(readLinkAction('web+cardano://addr1x')).toBeNull()
    expect(readLinkAction('https://pnyx.pxkq.uk/nope')).toBeNull()
  })

  it('reads a CIP-13 URI surrounded by whitespace', () => {
    // Messages arrive with newlines around them more often than not.
    const built = buildFundsRequest({addressBech32: ADDRESS, lovelace: 1n})
    if (!built.ok) throw new Error('expected a link')
    expect(readLinkAction(`\n  ${built.link}  \n`)?.kind).toBe('payment-request')
  })

  it('unwraps a brand link that only wraps a CIP-13 URI', () => {
    // The inner link is the request; the wrapper says nothing extra. Reading it by
    // the same rule means the card is the one the inner link deserves — and the
    // recursion is one step deep, since a `web+cardano:` URI cannot nest a brand
    // link inside it.
    expect(
      readLinkAction(
        buildBrandLink(
          {feature: 'transfer', useCase: 'request/ada-with-link', params: {link: `web+cardano:${ADDRESS}`}},
          PNYX_SCHEME,
        ),
      ),
    ).toMatchObject({kind: 'payment-request', address: ADDRESS})
  })

  it('names the brand shapes it cannot carry out, rather than dropping them', () => {
    // A wall of URL tells the reader nothing. These are named and offered nothing,
    // which is the honest half of the pair.
    expect(readLinkAction('pnyx://pnyx.pxkq.uk/w1/transfer/request/ada?amount=5')).toBeNull()
    expect(
      readLinkAction(
        buildBrandLink(
          {feature: 'exchange', useCase: 'order/show-create-result', params: {provider: 'p', orderType: 'buy'}},
          PNYX_SCHEME,
        ),
      ),
    ).toEqual({kind: 'named-only', what: 'exchangeResult', detail: 'p'})
  })
})

describe('readLinkAction — a backup, acted on behind its warning', () => {
  // The payload is encrypted and useless without its password, so this device is
  // not at risk. The risk it carries is that a seed you were handed is one its
  // sender kept, which the card and the sheet both say.
  it('offers to restore a backup, carrying the link the screen needs', () => {
    expect(readLinkAction('web+cardano://backup?enc=abc')).toMatchObject({kind: 'backup'})
  })

  it('rebuilds a link the restore screen can parse back', () => {
    const action = readLinkAction('web+cardano://backup?v=1&enc=abc')
    if (action?.kind !== 'backup') throw new Error('expected a backup action')
    expect(readLinkAction(action.link)).toMatchObject({kind: 'backup'})
  })
})

describe('readLinkAction — watch-only hand-off', () => {
  it('reads an address and its optional name', () => {
    expect(readLinkAction('web+cardano://watch/v1?address=addr1abc&name=Treasury')).toMatchObject({
      kind: 'watch-only',
      address: 'addr1abc',
      name: 'Treasury',
    })
  })

  it('keeps the address when no name is given', () => {
    expect(readLinkAction('web+cardano://watch/v1?address=stake1abc')).toMatchObject({
      kind: 'watch-only',
      address: 'stake1abc',
      name: undefined,
    })
  })

  it('is not read at all without an address, rather than offering an empty import', () => {
    expect(readLinkAction('web+cardano://watch/v1?name=Treasury')).toBeNull()
  })

  it('needs its version segment, so an unversioned link cannot mean something else later', () => {
    expect(readLinkAction('web+cardano://watch?address=addr1abc')).toBeNull()
  })
})

describe('readLinkAction — the links it names but will not act on', () => {
  it('names a connection request, which only the dApp itself may start', () => {
    expect(readLinkAction('web+cardano://connect?foo=bar')).toMatchObject({kind: 'named-only', what: 'connect'})
  })

  it('names a payment request for a chain this build cannot send on', () => {
    const link = buildBrandLink(
      {feature: 'transfer', useCase: 'request/crypto', params: {chain: 'eip155:1', address: '0xabc', amount: '1'}},
      PNYX_SCHEME,
    )
    expect(readLinkAction(link)).toEqual({kind: 'named-only', what: 'otherChain', detail: 'eip155:1'})
  })
})

describe('readLinkAction — a CIP-99 token claim', () => {
  const live =
    'web+cardano://claim/v1?faucet_url=https%3A%2F%2Fbeta.onbd.io%2Fapi%2Fclaim%2Fv1%2F01ksj7qeeg0kbh5s64ds2x9yya&code=01KSJ8PW11CPCG40G7S7TVKXZ9'

  it('reads the faucet, the code and the host', () => {
    expect(readLinkAction(live)).toEqual({
      kind: 'claim',
      faucetUrl: 'https://beta.onbd.io/api/claim/v1/01ksj7qeeg0kbh5s64ds2x9yya',
      host: 'beta.onbd.io',
      code: '01KSJ8PW11CPCG40G7S7TVKXZ9',
      params: {},
    })
  })

  it('carries the parameters CIP-99 says to forward', () => {
    expect(
      readLinkAction('web+cardano://claim/v1?faucet_url=https%3A%2F%2Ff.example&code=C1&invoice=99'),
    ).toMatchObject({params: {invoice: '99'}})
  })

  // Redeeming POSTs the user's receiving address, so a link that cannot name who
  // receives it is not carded at all.
  it('is not read at all over cleartext http', () => {
    expect(readLinkAction('web+cardano://claim/v1?faucet_url=http%3A%2F%2Ff.example&code=C1')).toBeNull()
  })
})

describe('readLinkAction — things to look at', () => {
  it('cards an address as something to send to', () => {
    expect(readLinkAction(`web+cardano://address/${ADDRESS}`)).toEqual({kind: 'address', address: ADDRESS})
  })

  it('cards a transaction for the app\u2019s own review, not the explorer', () => {
    // `/wallet/tx/<hash>` renders any on-chain transaction, so leaving the app for
    // one would be showing it worse somewhere else.
    const hash = 'a'.repeat(64)
    expect(readLinkAction(`web+cardano://transaction/${hash}`)).toEqual({kind: 'transaction', hash})
  })

  it('canonicalises a transaction hash, and refuses one the review could not fetch', () => {
    expect(readLinkAction(`web+cardano://transaction/${'A'.repeat(64)}`)).toEqual({
      kind: 'transaction',
      hash: 'a'.repeat(64),
    })
    // A tx id is 32 bytes; anything else 404s after the tap.
    expect(readLinkAction('web+cardano://transaction/aabb')).toBeNull()
    expect(readLinkAction(`web+cardano://transaction/${'z'.repeat(64)}`)).toBeNull()
  })

  it('cards a block for the explorer, which is the only viewer it has', () => {
    expect(readLinkAction('web+cardano://block/ccdd')).toEqual({kind: 'explorer', target: 'block', id: 'ccdd'})
  })
})

describe('readLinkAction — a payment request', () => {
  const link = (lovelace: bigint): string => {
    const built = buildFundsRequest({addressBech32: ADDRESS, lovelace})
    if (!built.ok) throw new Error('expected a link')
    return built.link
  }

  it('reads what the Receive screen produced', () => {
    // Builder and reader are the two ends of one contract; a test against a
    // hand-written string would pass while the real link said something else.
    expect(readLinkAction(link(5_000_000n))).toEqual({
      kind: 'payment-request',
      address: ADDRESS,
      lovelace: 5_000_000n,
      message: undefined,
      paymentId: undefined,
      asksForAssets: false,
    })
  })

  it('reads an open request as having no amount', () => {
    expect(readLinkAction(link(0n))).toMatchObject({kind: 'payment-request', lovelace: null})
  })

  it('survives an amount past 2^53', () => {
    expect(readLinkAction(link(9_007_199_254_740_993n))).toMatchObject({lovelace: 9_007_199_254_740_993n})
  })

  it('reads a CIP-13 URI from another wallet, not only our own', () => {
    // The reason for the shape: a request built anywhere has to work here.
    expect(readLinkAction(`web+cardano://pay?address=${ADDRESS}&amount=1234567&message=lunch`)).toEqual({
      kind: 'payment-request',
      address: ADDRESS,
      lovelace: 1_234_567n,
      message: 'lunch',
      paymentId: undefined,
      // CIP-13 predates native assets entirely, so it cannot have asked.
      asksForAssets: false,
    })
  })

  it('reads the legacy bare form CIP-13 also allows', () => {
    expect(readLinkAction(`web+cardano:${ADDRESS}`)).toMatchObject({kind: 'payment-request', address: ADDRESS})
  })
})

describe('readLinkAction — a co-sign request', () => {
  const envelope = (over: Record<string, unknown> = {}) => ({
    version: 1,
    chainId: 'cardano:preprod',
    createdAt: '2026-08-09T20:00:00Z',
    createdBy: 'me',
    kind: 'multisig',
    bodyHex: 'aabb',
    nativeScriptHexes: ['cc'],
    signers: [
      {id: 's1', name: 'Me', keyHashHex: '11', signed: true},
      {id: 's2', name: 'Ana', keyHashHex: '22', signed: false},
    ],
    witnesses: [],
    networkId: 0,
    accountIndex: 0,
    keyIndexes: [0],
    ...over,
  })

  it('reads a transaction envelope in a message body', () => {
    // It travels as the body, not a link: an envelope carries the tx, its scripts
    // and every witness so far — kilobytes, which fit no URI and no QR.
    const action = readLinkAction(JSON.stringify(envelope()))
    expect(action).toMatchObject({kind: 'cosign-request'})
  })

  it('normalises the chain id on the way in', () => {
    // A mislabelled network is how a preprod transaction gets signed against
    // mainnet keys, so one spelling is stored.
    const action = readLinkAction(JSON.stringify(envelope({chainId: 'cip34:0-1'})))
    expect(action).toMatchObject({kind: 'cosign-request', envelope: {chainId: 'cardano:preprod'}})
  })

  it('is chat for JSON that is not an envelope', () => {
    for (const body of ['{}', '{"hello":"there"}', '{"version":2,"bodyHex":"aa"}', '{ not json']) {
      expect(readLinkAction(body)).toBeNull()
    }
  })

  it('refuses an envelope whose chain id it cannot place', () => {
    expect(readLinkAction(JSON.stringify(envelope({chainId: 'bitcoin:mainnet'})))).toBeNull()
  })

  it('leaves ordinary text alone without parsing it', () => {
    // The gate is the leading brace; everything else must not pay for a parse.
    expect(readLinkAction('meet me at the bridge')).toBeNull()
  })
})

describe('readLinkAction — delegation', () => {
  it('reads a CIP-13 stake pool URI', () => {
    expect(readLinkAction(`web+cardano://stake?poolId=${POOL_ID}`)).toEqual({
      kind: 'stake-delegation',
      poolId: POOL_ID,
    })
  })

  it('reads a DRep URI, canonicalising the target', () => {
    expect(readLinkAction(`web+cardano://drep?drepId=${DREP_CIP105_ID}`)).toEqual({
      kind: 'drep-delegation',
      drepId: DREP_CIP105_ID,
      target: DREP_TARGET,
    })
  })

  it('reads both spellings of one DRep credential to the same target', () => {
    // CIP-129 and legacy CIP-105 share the `drep` hrp. Carrying the raw id alone
    // would make one credential look like two, and "already delegated to this
    // DRep" would be wrong for whichever spelling the link happened to use.
    const a = readLinkAction(`web+cardano://drep?drepId=${DREP_CIP105_ID}`)
    const b = readLinkAction(`web+cardano://drep?drepId=${DREP_CIP129_ID}`)
    expect(a).toMatchObject({target: DREP_TARGET})
    expect(b).toMatchObject({target: DREP_TARGET})
  })

  it('cards the two system DRep targets, which are not ids at all', () => {
    expect(readLinkAction('web+cardano://drep?drepId=drep_always_abstain')).toMatchObject({
      target: {kind: 'abstain'},
    })
    expect(readLinkAction('web+cardano://drep?drepId=drep_always_no_confidence')).toMatchObject({
      target: {kind: 'no_confidence'},
    })
  })

  it('refuses an id it could not delegate to', () => {
    // The whole point of carding these: the button hands the id to the staking
    // screen. An id that cannot become a certificate would be a card promising
    // something that fails after the tap, so it stays chat with the URL visible.
    for (const uri of [
      'web+cardano://stake?poolId=pool1abc',
      `web+cardano://stake?poolId=${DREP_CIP105_ID}`,
      'web+cardano://stake?poolId=not-a-pool',
      'web+cardano://drep?drepId=drep1xyz',
      `web+cardano://drep?drepId=${POOL_ID}`,
      'web+cardano://drep?drepId=nonsense',
    ]) {
      expect(readLinkAction(uri)).toBeNull()
    }
  })
})

describe('readLinkAction — a request for a co-signer key', () => {
  const invite = buildBrandLink({feature: 'multisig', useCase: 'invite', params: {}}, PNYX_SCHEME)

  it('cards a request that carries nothing', () => {
    expect(invite).toContain('multisig/invite')
    expect(readLinkAction(invite)).toEqual({kind: 'multisig-invite'})
  })

  it('still cards a request from an older build, ignoring what it carried', () => {
    // Those links named the wallet being built and the sender's own funds wallet.
    // Refusing them would leave a request from a phone that has not updated
    // uncardable, which reads as a broken message rather than an old one.
    const legacy = `${invite}?walletName=Treasury&fromName=Abandon%2015&inviteId=w1%3Anew`
    expect(readLinkAction(legacy)).toEqual({kind: 'multisig-invite'})
  })
})

describe('readLinkAction — a co-signer key', () => {
  it('refuses a key that will not decode', () => {
    // It would be bound into a spending policy permanently, so a key that is not
    // a key is never offered as one.
    const bogus = buildBrandLink(
      {feature: 'multisig', useCase: 'cosigner-key', params: {key: 'acct_shared_xvk1nope'}},
      PNYX_SCHEME,
    )
    expect(readLinkAction(bogus)).toBeNull()
  })

  it('reads the key, and only the key', () => {
    // Encoded by the same codec the sender uses, so this is the real round trip
    // rather than a hand-typed bech32 string that might only look right.
    const link = buildCoSignerLink(XPUB_HEX)
    if (Either.isLeft(link)) throw new Error(`fixture key did not encode: ${link.left.kind}`)
    expect(readLinkAction(link.right)).toEqual({kind: 'cosigner-key', accountXpubHex: XpubHex(XPUB_HEX)})
  })

  it('drops a name and account index sent by an older build', () => {
    const bech32 = new URL(Either.getOrThrow(buildCoSignerLink(XPUB_HEX))).searchParams.get('key') ?? ''
    const legacy = buildBrandLink(
      {feature: 'multisig', useCase: 'cosigner-key', params: {key: bech32, name: 'Bob', accountIndex: 3}},
      PNYX_SCHEME,
    )
    expect(readLinkAction(legacy)).toEqual({kind: 'cosigner-key', accountXpubHex: XpubHex(XPUB_HEX)})
  })
})

describe('readLinkAction — a shared-wallet definition', () => {
  const KEY_A = 'a'.repeat(128)
  const KEY_B = 'b'.repeat(128)
  const template = {
    kind: 'all' as const,
    scripts: [
      {kind: 'cosigner' as const, tag: 'cosigner#0'},
      {kind: 'cosigner' as const, tag: 'cosigner#1'},
    ],
  }
  const definition = {
    name: 'Rent pot',
    coSigners: [
      {tag: 'cosigner#0', name: 'Jordi', accountXpubHex: XpubHex(KEY_A)},
      {tag: 'cosigner#1', name: 'Alex', accountXpubHex: XpubHex(KEY_B)},
    ],
    paymentTemplate: template,
    delegationTemplate: template,
    network: Address.Network.Mainnet,
    accountIndex: 0,
  }

  it('reads the roster and the policy back out of a real link', () => {
    // Through the same builder a wallet uses to share itself, so this is the round
    // trip rather than a hand-written payload that might only look right.
    const link = buildDefinitionLink({...definition, id: 'w', createdAt: 'now'})
    expect(readLinkAction(link)).toEqual({kind: 'shared-wallet', definition})
  })

  it('refuses a payload that does not decode into a wallet', () => {
    const bogus = buildBrandLink(
      {feature: 'multisig', useCase: 'wallet', params: {def: 'not-a-definition'}},
      PNYX_SCHEME,
    )
    expect(readLinkAction(bogus)).toBeNull()
  })
})

describe('readLinkAction — a dApp', () => {
  const launch = (dappUrl: string): string =>
    buildBrandLink({feature: 'browser', useCase: 'launch', params: {dappUrl}}, PNYX_SCHEME)

  it('says where it goes', () => {
    expect(readLinkAction(launch('https://app.example.com/swap?x=1'))).toEqual({
      kind: 'dapp',
      url: 'https://app.example.com/swap?x=1',
      host: 'app.example.com',
    })
  })

  it('refuses a scheme that is not the web', () => {
    // A card offering to "open a dApp" that in fact runs a javascript: URL is
    // describing something other than what it does.
    expect(readLinkAction(launch('javascript:alert(1)'))).toBeNull()
    expect(readLinkAction(launch('file:///etc/passwd'))).toBeNull()
  })

  it('refuses a URL with no host to name', () => {
    expect(readLinkAction(launch('https://'))).toBeNull()
    expect(readLinkAction(launch('not a url'))).toBeNull()
  })
})

describe('readLinkAction — CIP-157 enhanced payments', () => {
  const ASSET_A = 'asset12ffdj8kk2w485sr7a5ekmjjdyecz8ps2cm5zed'
  const ASSET_B = 'asset17q7r59zlc3dgw0venc80pdv566q6yguw03f0d9'

  it('reads the amount, note and reference — the parts it can honour', () => {
    // The spec's own "all optional parameters" example minus its token, address
    // swapped for a testnet one so the fixture matches what this app receives.
    const uri = `web+cardano://pay/v1/${ADDRESS}?l=5000000&i=order1234&n=Swag%20Booth%20Redemption`
    expect(readLinkAction(uri)).toEqual({
      kind: 'payment-request',
      address: ADDRESS,
      lovelace: 5_000_000n,
      message: 'Swag Booth Redemption',
      paymentId: 'order1234',
      asksForAssets: false,
    })
  })

  it('flags a token request without surfacing the fingerprints', () => {
    // CIP-157 names assets by CIP-14 fingerprint — a one-way hash of (policy, name),
    // recoverable only by matching against assets the payer already holds, which this
    // app does not do. The ids are unreadable and unusable, so they are not shown; the
    // *fact* is carried, because paying the ADA in silence would look like the request
    // was settled.
    const flagged = readLinkAction(`web+cardano://pay/v1/${ADDRESS}?l=1000000&t=${ASSET_A}*3`)
    expect(flagged).toMatchObject({kind: 'payment-request', lovelace: 1_000_000n, asksForAssets: true})
    // No fingerprint anywhere on the action — nothing downstream can render one.
    expect(Object.values(flagged ?? {}).some((v) => typeof v === 'string' && v.includes('asset1'))).toBe(false)
    expect(readLinkAction(`web+cardano://pay/v1/${ADDRESS}?t=${ASSET_A},${ASSET_B}*5`)).toMatchObject({
      asksForAssets: true,
    })
  })

  it('reads the minimal shape — an address and nothing else', () => {
    expect(readLinkAction(`web+cardano://pay/v1/${ADDRESS}`)).toEqual({
      kind: 'payment-request',
      address: ADDRESS,
      lovelace: null,
      message: undefined,
      paymentId: undefined,
      asksForAssets: false,
    })
  })

  it('refuses a malformed asset rather than dropping it', () => {
    // The dangerous direction: a request for three tokens that silently became two
    // builds a payment which looks complete and is short what was asked for.
    for (const t of [
      'notanasset',
      `${ASSET_A}*`,
      `${ASSET_A}*0`,
      `${ASSET_A}*-1`,
      `${ASSET_A}*1.5`,
      `${ASSET_A},bad`,
    ]) {
      expect(readLinkAction(`web+cardano://pay/v1/${ADDRESS}?t=${t}`)).toBeNull()
    }
  })

  it('refuses a note past the 64 characters the CIP allows', () => {
    const long = encodeURIComponent('x'.repeat(65))
    expect(readLinkAction(`web+cardano://pay/v1/${ADDRESS}?n=${long}`)).toBeNull()
    expect(readLinkAction(`web+cardano://pay/v1/${ADDRESS}?n=${encodeURIComponent('x'.repeat(64))}`)).not.toBeNull()
  })

  it('refuses a version it does not implement rather than guessing', () => {
    expect(readLinkAction(`web+cardano://pay/v2/${ADDRESS}`)).toBeNull()
  })

  it('refuses a lovelace amount that is not a plain integer', () => {
    expect(readLinkAction(`web+cardano://pay/v1/${ADDRESS}?l=1.5`)).toBeNull()
    expect(readLinkAction(`web+cardano://pay/v1/${ADDRESS}?l=-1`)).toBeNull()
  })

  it('still reads the older query shape, which shares the pay authority', () => {
    // The version segment is what tells them apart, so neither breaks the other.
    expect(readLinkAction(`web+cardano://pay?address=${ADDRESS}&amount=1`)).toMatchObject({lovelace: 1n})
  })
})
