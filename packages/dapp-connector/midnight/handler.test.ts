import type {Configuration, ConnectionStatus, HistoryEntry} from '@midnight-ntwrk/dapp-connector-api'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {invalidRequest} from '../resolver.js'
import type {WireError} from '../types.js'
import {createMidnightHandler, type MidnightHandlerContext} from './handler.js'

const CONFIG: Configuration = {
  indexerUri: 'https://indexer.preprod.midnight.network/api/v4/graphql',
  indexerWsUri: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
  substrateNodeUri: 'https://rpc.preprod.midnight.network',
  networkId: 'preprod',
}

const CONNECTED: ConnectionStatus = {status: 'connected', networkId: 'preprod'}

const HISTORY: readonly HistoryEntry[] = [
  {txHash: 'aa', txStatus: {status: 'confirmed', executionStatus: {1: 'Success'}}},
]

const context = (over: Partial<MidnightHandlerContext> = {}): MidnightHandlerContext => ({
  unshieldedAddress: Effect.succeed('mn_addr_preprod1abc'),
  dustAddress: Effect.succeed('mn_dust1abc'),
  shieldedAddresses: Effect.succeed({
    shieldedAddress: 'mn_shield-addr_preprod1abc',
    shieldedCoinPublicKey: 'mn_shield-cpk_preprod1abc',
    shieldedEncryptionPublicKey: 'mn_shield-epk_preprod1abc',
  }),
  // Past 2^53, which is the whole reason amounts cross as strings.
  unshieldedBalances: Effect.succeed({['00'.repeat(32)]: 9_007_199_254_740_993n}),
  shieldedBalances: Effect.succeed({['11'.repeat(32)]: 42n}),
  checkPreimage: () => Effect.succeed([undefined, 3]),
  proveCircuit: () => Effect.succeed(new Uint8Array([0xaa, 0xbb])),
  dustBalance: Effect.succeed({cap: 5_000n, balance: 1_234n}),
  configuration: Effect.succeed(CONFIG),
  connectionStatus: Effect.succeed(CONNECTED),
  txHistory: () => Effect.succeed(HISTORY),
  hintUsage: () => Effect.void,
  ...over,
})

/** Run one method and report it as the dApp would see it: a value, or the error it failed with. */
/** Connected by default; the gate itself is exercised with `connected: false`. */
const call = async (
  ctx: MidnightHandlerContext,
  method: string,
  params: unknown = [],
  connected = true,
): Promise<{ok: true; value: unknown} | {ok: false; error: unknown}> => {
  const handler = createMidnightHandler(ctx, () => Effect.succeed(connected)).methods.get(method)
  if (handler === undefined) throw new Error(`no handler for ${method}`)
  const either = await Effect.runPromise(
    Effect.either(handler(params, {origin: 'https://dapp.example', chainType: 'midnight'})),
  )
  return either._tag === 'Right' ? {ok: true, value: either.right} : {ok: false, error: either.left}
}

describe('createMidnightHandler', () => {
  it('serves the whole read surface it claims, and nothing it cannot answer', () => {
    const served = [...createMidnightHandler(context(), () => Effect.succeed(true)).methods.keys()].sort()

    expect(served).toEqual([
      'balanceSealedTransaction',
      'balanceUnsealedTransaction',
      'connect',
      'deriveAppSecret',
      'getConfiguration',
      'getConnectionStatus',
      'getDustAddress',
      'getDustBalance',
      'getProvingProvider',
      'getShieldedAddresses',
      'getShieldedBalances',
      'getTxHistory',
      'getUnshieldedAddress',
      'getUnshieldedBalances',
      'hintUsage',
      'makeIntent',
      'makeTransfer',
      'provingProviderCheck',
      'provingProviderProve',
      'signData',
      'submitTransaction',
    ])
  })

  it('reports the chain it serves', () => {
    expect(createMidnightHandler(context(), () => Effect.succeed(true)).chainType).toBe('midnight')
  })

  it('answers the address reads in the shapes the API specifies', async () => {
    expect(await call(context(), 'getUnshieldedAddress')).toEqual({
      ok: true,
      value: {unshieldedAddress: 'mn_addr_preprod1abc'},
    })
    expect(await call(context(), 'getDustAddress')).toEqual({ok: true, value: {dustAddress: 'mn_dust1abc'}})
    const shielded = await call(context(), 'getShieldedAddresses')
    expect(shielded.ok && Object.keys(shielded.value as object).sort()).toEqual([
      'shieldedAddress',
      'shieldedCoinPublicKey',
      'shieldedEncryptionPublicKey',
    ])
  })
})

describe('amounts crossing the bridge', () => {
  it('sends an unshielded balance as a decimal string, losing nothing past 2^53', async () => {
    const result = await call(context(), 'getUnshieldedBalances')

    // A Number here would round to ...992; a bigint would make JSON.stringify throw.
    expect(result).toEqual({ok: true, value: {['00'.repeat(32)]: '9007199254740993'}})
  })

  it('sends the DUST cap and balance as decimal strings', async () => {
    expect(await call(context(), 'getDustBalance')).toEqual({ok: true, value: {cap: '5000', balance: '1234'}})
  })

  it('keeps a zero balance as "0" rather than dropping the token', async () => {
    const ctx = context({unshieldedBalances: Effect.succeed({['00'.repeat(32)]: 0n})})

    // A token we hold none of is a different fact from a token absent from the wallet.
    expect(await call(ctx, 'getUnshieldedBalances')).toEqual({ok: true, value: {['00'.repeat(32)]: '0'}})
  })
})

describe('parameter handling', () => {
  it('rejects parameters on a nullary method instead of ignoring them', async () => {
    // A dApp passing arguments has misread the API; answering anyway hides that from its author.
    const result = await call(context(), 'getUnshieldedAddress', ['unexpected'])

    expect(result.ok).toBe(false)
  })

  it('accepts an absent or empty parameter list', async () => {
    expect((await call(context(), 'getConfiguration', undefined)).ok).toBe(true)
    expect((await call(context(), 'getConfiguration', [])).ok).toBe(true)
  })

  it('passes paging through to the host', async () => {
    let seen: {page: number; size: number} | null = null
    const ctx = context({
      txHistory: (page, size) => {
        seen = {page, size}
        return Effect.succeed(HISTORY)
      },
    })

    const result = await call(ctx, 'getTxHistory', [2, 25])

    expect(seen).toEqual({page: 2, size: 25})
    expect(result).toEqual({ok: true, value: HISTORY})
  })

  it('refuses a non-positive or non-integer page rather than clamping it', async () => {
    // Clamping 0 to 1 would hand the dApp page 1 twice and let it conclude the history repeats.
    for (const args of [[0, 10], [1, 0], [-1, 10], [1.5, 10], ['1', '10'], []]) {
      expect((await call(context(), 'getTxHistory', args)).ok).toBe(false)
    }
  })

  it('takes a method-name array for hintUsage and answers null, not undefined', async () => {
    // `undefined` vanishes from JSON, leaving a dApp unable to tell success from a dropped field.
    expect(await call(context(), 'hintUsage', [['getUnshieldedBalances']])).toEqual({ok: true, value: null})
  })

  it('refuses a malformed hintUsage payload', async () => {
    expect((await call(context(), 'hintUsage', ['getUnshieldedBalances'])).ok).toBe(false)
    expect((await call(context(), 'hintUsage', [[1, 2]])).ok).toBe(false)
  })
})

describe('getShieldedBalances', () => {
  it('answers per token type from the synced state', async () => {
    expect(await call(context(), 'getShieldedBalances')).toEqual({ok: true, value: {['11'.repeat(32)]: '42'}})
  })

  it('fails rather than answering an empty wallet when nothing is synced', async () => {
    // `{}` is the answer for a wallet holding nothing; "never synced" is a different fact and the API
    // has no way to say it, so the honest reply is a refusal the dApp can surface.
    const unsynced = context({shieldedBalances: Effect.fail(invalidRequest('no synced shielded state'))})

    expect((await call(unsynced, 'getShieldedBalances')).ok).toBe(false)
  })

  it('needs an approved session, like every other read', async () => {
    expect((await call(context(), 'getShieldedBalances', [], false)).ok).toBe(false)
  })
})

describe('signData', () => {
  /** `utf8("midnight_signed_message:2:")`, the envelope for a two-byte payload. */
  const ENVELOPE_2 = '6d69646e696768745f7369676e65645f6d6573736167653a323a'

  it('asks for approval rather than answering, and hands over the bytes it will sign', async () => {
    // Nothing is signed without the user seeing it, so the handler's whole job is to refuse with a
    // sentinel the host catches — the same shape the Cardano handler uses for CIP-8.
    const result = await call(context(), 'signData', ['00ff', {encoding: 'hex', keyType: 'unshielded'}])

    expect(result.ok).toBe(false)
    const error = (result as {ok: false; error: Record<string, unknown>}).error
    expect(error._tag).toBe('MidnightSignDataRequired')
    // The payload inside the domain-separated envelope, never the payload alone — the key that answers
    // this also authorises unshielded spends. See sign-data.ts.
    expect(error.messageHex).toBe(`${ENVELOPE_2}00ff`)
    expect(error.data).toBe('00ff')
    expect(error.origin).toBe('https://dapp.example')
  })

  it('decodes text to UTF-8 before handing it over, not UTF-16', async () => {
    const result = await call(context(), 'signData', ['é', {encoding: 'text'}])

    const error = (result as {ok: false; error: Record<string, unknown>}).error
    expect(error.messageHex).toBe(`${ENVELOPE_2}c3a9`)
    // The payload is echoed exactly as sent, while the bytes are the UTF-8 conversion.
    expect(error.data).toBe('é')
  })

  it('refuses a malformed payload before asking anyone to approve it', async () => {
    const result = await call(context(), 'signData', ['abc', {encoding: 'hex'}])

    const error = (result as {ok: false; error: Record<string, unknown>}).error
    expect(error._tag).toBe('WireError')
  })
})

describe('makeTransfer', () => {
  const output = {kind: 'unshielded', type: '00'.repeat(32), value: '1000000', recipient: 'mn_addr_preprod1abc'}

  it('routes to the host for review rather than building anything itself', async () => {
    const result = await call(context(), 'makeTransfer', [[output]])

    expect(result.ok).toBe(false)
    const error = (result as {ok: false; error: Record<string, unknown>}).error
    expect(error._tag).toBe('MidnightTransferRequired')
    // The value reaches the host as a bigint: the sentinel never crosses the JSON bridge.
    expect(error.outputs).toEqual([
      {kind: 'unshielded', tokenType: '00'.repeat(32), value: 1_000_000n, recipient: 'mn_addr_preprod1abc'},
    ])
    expect(error.origin).toBe('https://dapp.example')
  })

  it('refuses a malformed request before anyone is asked to approve it', async () => {
    const result = await call(context(), 'makeTransfer', [[{...output, value: '1.5'}]])

    expect((result as {ok: false; error: Record<string, unknown>}).error._tag).toBe('WireError')
  })

  it('needs an approved session', async () => {
    const result = await call(context(), 'makeTransfer', [[output]], false)

    // A refusal, not a review: an unapproved page must not be able to raise a sheet at all.
    expect((result as {ok: false; error: Record<string, unknown>}).error._tag).toBe('WireError')
  })
})

describe('balanceUnsealedTransaction', () => {
  it('routes to the host, which is the only side that can read what the transaction owes', async () => {
    const result = await call(context(), 'balanceUnsealedTransaction', ['ABcd'])

    const error = (result as {ok: false; error: Record<string, unknown>}).error
    expect(error._tag).toBe('MidnightBalanceRequired')
    expect(error.txHex).toBe('abcd')
    expect(error.origin).toBe('https://dapp.example')
  })

  it('routes payFees: false to the host rather than refusing it here', async () => {
    // The host is the layer that knows whether this wallet can fund a transaction itself, so the
    // decision moved there — see `useDappConnector`. The resolver only carries the flag.
    const result = await call(context(), 'balanceUnsealedTransaction', ['abcd', {payFees: false}])

    const error = (result as {ok: false; error: Record<string, unknown>}).error
    expect(error._tag).toBe('MidnightBalanceRequired')
    expect(error.payFees).toBe(false)
  })

  it('refuses anything that is not a hex transaction', async () => {
    for (const bad of [[], [''], ['zz'], ['abc'], [123]]) {
      const result = await call(context(), 'balanceUnsealedTransaction', bad)
      expect((result as {ok: false; error: Record<string, unknown>}).error._tag).toBe('WireError')
    }
  })

  it('needs an approved session', async () => {
    const result = await call(context(), 'balanceUnsealedTransaction', ['abcd'], false)

    expect((result as {ok: false; error: Record<string, unknown>}).error._tag).toBe('WireError')
  })
})

describe('the methods this wallet declares and refuses', () => {
  it('refuses a sealed balance with the route a dApp should take instead', async () => {
    // Declared rather than absent: the spec marks no method of ConnectedAPI optional, so an absent one
    // gives a dApp a TypeError where an APIError was due.
    const result = await call(context(), 'balanceSealedTransaction', ['abcd'])

    const error = (result as {ok: false; error: Record<string, unknown>}).error
    expect(error._tag).toBe('WireError')
    expect(error.apiCode).toBe('InternalError')
    expect(String(error.message)).toMatch(/balanceUnsealedTransaction/)
  })

  it('says makeIntent is not built, which is a different fact', async () => {
    const result = await call(context(), 'makeIntent', [[], []])

    const error = (result as {ok: false; error: Record<string, unknown>}).error
    expect(error.apiCode).toBe('InternalError')
    expect(String(error.message)).toMatch(/does not build intents yet/)
  })

  it('needs an approved session before it will even say that', async () => {
    // An unapproved page learns nothing about this wallet, not even what it cannot do.
    for (const method of ['balanceSealedTransaction', 'makeIntent']) {
      const result = await call(context(), method, ['abcd'], false)
      const error = (result as {ok: false; error: Record<string, unknown>}).error
      expect(error.apiCode).toBe('PermissionRejected')
    }
  })
})

describe('submitTransaction', () => {
  it('routes the bytes to the host, which holds the sponsor session', async () => {
    const result = await call(context(), 'submitTransaction', ['ABcd'])

    const error = (result as {ok: false; error: Record<string, unknown>}).error
    expect(error._tag).toBe('MidnightSubmitRequired')
    expect(error.txHex).toBe('abcd')
  })

  it('refuses anything that is not a hex transaction', async () => {
    for (const bad of [[], [''], ['zz'], ['abc'], [123]]) {
      const result = await call(context(), 'submitTransaction', bad)
      expect((result as {ok: false; error: Record<string, unknown>}).error._tag).toBe('WireError')
    }
  })

  it('needs an approved session', async () => {
    const result = await call(context(), 'submitTransaction', ['abcd'], false)

    expect((result as {ok: false; error: Record<string, unknown>}).error._tag).toBe('WireError')
  })
})

describe('host failures', () => {
  it('surfaces a read failure as the wire error the host raised', async () => {
    const failure = invalidRequest('no funds group selected') as WireError
    const result = await call(context({unshieldedAddress: Effect.fail(failure)}), 'getUnshieldedAddress')

    // Never a fabricated address, and never a silent empty string.
    expect(result).toEqual({ok: false, error: failure})
  })
})

describe('the connection gate', () => {
  const methods = [
    'getUnshieldedAddress',
    'getDustAddress',
    'getShieldedAddresses',
    'getUnshieldedBalances',
    'getDustBalance',
    'getConfiguration',
  ]

  it('refuses every read from a page that has not been authorised', async () => {
    // The whole reason the approval exists: an unapproved page must not learn an address or a balance.
    for (const method of methods) {
      expect((await call(context(), method, [], false)).ok, method).toBe(false)
    }
  })

  it('refuses history and hintUsage unauthorised too', async () => {
    expect((await call(context(), 'getTxHistory', [1, 10], false)).ok).toBe(false)
    expect((await call(context(), 'hintUsage', [['getDustBalance']], false)).ok).toBe(false)
  })

  it('refuses signData before it ever reaches the signing sheet', async () => {
    const result = await call(context(), 'signData', ['ab', {encoding: 'hex'}], false)

    expect(result.ok).toBe(false)
    // A refusal, not the approval sentinel — the user is never asked on behalf of an unapproved page.
    expect((result as {ok: false; error: {_tag?: string}}).error._tag).not.toBe('MidnightSignDataRequired')
  })

  it('answers getConnectionStatus unauthorised, because disconnected is the honest answer', async () => {
    // The one method a dApp must be able to ask before prompting the user.
    expect(await call(context(), 'getConnectionStatus', [], false)).toEqual({
      ok: true,
      value: {status: 'disconnected'},
    })
  })

  it('reports the live status once authorised', async () => {
    expect(await call(context(), 'getConnectionStatus', [], true)).toEqual({ok: true, value: CONNECTED})
  })
})

describe('connect', () => {
  it('asks for approval when there is no session', async () => {
    const result = await call(context(), 'connect', ['preprod'], false)

    expect(result.ok).toBe(false)
    expect((result as {ok: false; error: {_tag?: string}}).error._tag).toBe('ConnectionRequired')
  })

  it('answers the status when already authorised', async () => {
    expect(await call(context(), 'connect', ['preprod'], true)).toEqual({ok: true, value: CONNECTED})
  })

  it('refuses a network the wallet is not on', async () => {
    // An API silently bound to the wrong chain is the one failure a dApp cannot detect afterwards.
    const result = await call(context(), 'connect', ['mainnet'], true)

    expect(result.ok).toBe(false)
  })

  it('accepts an absent network id as "whatever you are on"', async () => {
    expect((await call(context(), 'connect', [], true)).ok).toBe(true)
  })

  it('refuses a non-string network id', async () => {
    expect((await call(context(), 'connect', [42], true)).ok).toBe(false)
  })
})
