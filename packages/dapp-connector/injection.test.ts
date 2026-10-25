import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {generateInjectionScript, RESPONSE_CALLBACK} from './injection.js'
import {createMidnightHandler, type MidnightHandlerContext} from './midnight/handler.js'

const config = {
  walletName: 'Pnyx',
  apiVersion: '1',
  sessionId: 'session-abc',
  providerNames: ['pnyx', 'pnyxwallet'] as const,
  midnightApiVersion: '4.1.0',
  midnightRdns: 'uk.pxkq.pnyx',
  midnightUuid: '11111111-2222-3333-4444-555555555555',
}

type InstalledProvider = {name: string; icon?: string | undefined; apiVersion: string}

/**
 * Run the script against a stand-in `window` and hand back the `window.cardano`
 * registry it installed — the same thing a dApp reads. Asserting on the
 * resulting object rather than on substrings of the source keeps these tests
 * from passing on a script that embeds the right text but wires it up wrong.
 */
const installProviders = (script: string): Record<string, InstalledProvider | undefined> => {
  const fakeWindow: Record<string, unknown> = {
    ReactNativeWebView: {postMessage: () => {}},
    location: {origin: 'https://dapp.example'},
    addEventListener: () => {},
    dispatchEvent: () => true,
  }
  new Function('window', script)(fakeWindow)
  return (fakeWindow.cardano ?? {}) as Record<string, InstalledProvider | undefined>
}

/** Run the script and hand back what it installed on `window.midnight`, plus what it posted. */
const runForMidnight = (
  script: string,
): {
  registry: Record<string, MidnightInitial | undefined>
  posted: string[]
  respond: (response: unknown) => void
} => {
  const posted: string[] = []
  const fakeWindow: Record<string, unknown> = {
    ReactNativeWebView: {postMessage: (m: string) => posted.push(m)},
    location: {origin: 'https://dapp.example'},
    addEventListener: () => {},
    dispatchEvent: () => true,
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  new Function('window', 'setTimeout', 'clearTimeout', script)(
    fakeWindow,
    () => 0,
    () => {},
  )
  return {
    registry: (fakeWindow.midnight ?? {}) as Record<string, MidnightInitial | undefined>,
    posted,
    respond: (response) => (fakeWindow[RESPONSE_CALLBACK] as (r: unknown) => void)(response),
  }
}

/** The connected surface, with the two amount-returning reads named so a test can call them directly. */
type MidnightConnected = {
  getUnshieldedBalances: () => Promise<Record<string, bigint>>
  getDustBalance: () => Promise<{cap: bigint; balance: bigint}>
} & Record<string, ((...args: never[]) => Promise<unknown>) | undefined>

type MidnightInitial = {
  rdns: string
  name: string
  icon: string
  apiVersion: string
  connect: (networkId: string) => Promise<MidnightConnected>
}

describe('generateInjectionScript', () => {
  it('embeds the config and installs every provider name', () => {
    const script = generateInjectionScript(config)
    expect(script).toContain('"walletName":"Pnyx"')
    expect(script).toContain('"sessionId":"session-abc"')
    expect(script).toContain('"providerNames":["pnyx","pnyxwallet"]')
    expect(script).toContain('window.cardano')
  })

  it('posts DappMessage JSON over the ReactNativeWebView bridge', () => {
    const script = generateInjectionScript(config)
    expect(script).toContain('window.ReactNativeWebView.postMessage(JSON.stringify(message))')
    expect(script).toContain('origin: window.location.origin')
  })

  it('tags a Cardano call as cardano — asserted from a real message, not the source', () => {
    // `post` takes the chain as an argument now that one script serves both, so grepping the source for
    // a hardcoded literal no longer says anything. What matters is the message a call actually produces.
    const posted: string[] = []
    const fakeWindow: Record<string, unknown> = {
      ReactNativeWebView: {postMessage: (m: string) => posted.push(m)},
      location: {origin: 'https://dapp.example'},
      addEventListener: () => {},
      dispatchEvent: () => true,
    }
    new Function('window', 'setTimeout', 'clearTimeout', generateInjectionScript(config))(
      fakeWindow,
      () => 0,
      () => {},
    )
    // The registry holds the *initial* API, per CIP-30 — the rest arrives after `enable()`.
    const cardano = (fakeWindow.cardano as Record<string, {enable: () => Promise<unknown>}>).pnyx as {
      enable: () => Promise<unknown>
    }
    void cardano.enable()

    const message = JSON.parse(posted[0] as string)
    expect(message.chainType).toBe('cardano')
    expect(message.method).toBe('enable')
  })

  it('defines the response callback the host injects into', () => {
    const script = generateInjectionScript(config)
    expect(script).toContain(`window.${RESPONSE_CALLBACK} = function (response)`)
  })

  it('routes signing failures to CIP-30 error classes', () => {
    const script = generateInjectionScript(config)
    expect(script).toContain('TxSignError')
    expect(script).toContain('DataSignError')
    expect(script).toContain("if (method === 'signTx')")
  })

  it('advertises CIP-95 + CIP-142 + CIP-139 and dispatches the load event', () => {
    const script = generateInjectionScript(config)
    expect(script).toContain('[{cip: 95}, {cip: 142}, {cip: 139}]')
    expect(script).toContain("new Event('cardano.walletLoaded')")
  })

  // CIP-139's two transport documents disagree on the injected shape — cip-0144.md
  // names flat operations, ts-api.md defines a nested `api.query.*` for injected JS —
  // so both are exposed as aliases over the same calls.
  it('exposes the CIP-139 query layer under both documented shapes', () => {
    const script = generateInjectionScript(config)
    expect(script).toContain("call('cip139_getUtxosByAddress'")
    expect(script).toContain('cip139: {')
    expect(script).toContain('query: {')
    expect(script).toContain('protocol_parameters: {')
    expect(script).toContain('stake_credential: function')
  })

  it('keeps the CIP-139 gap fillers under `experimental`, not in the standard surface', () => {
    // A dApp cannot set a validity interval without the current slot, and CIP-139 has
    // no chain-tip operation — but that gap must not be papered over as 139 surface.
    const script = generateInjectionScript(config)
    expect(script).toContain('experimental: {')
    expect(script).toContain("call('experimental_tip')")
    expect(script).toContain("call('experimental_resolveOutpoints'")
    expect(script).not.toContain('cip139_tip')
  })

  it('is syntactically valid JavaScript', () => {
    // eslint-style parse check: Function constructor throws on syntax errors
    expect(() => new Function(generateInjectionScript(config))).not.toThrow()
  })

  it('requires at least one provider name', () => {
    expect(() => generateInjectionScript({...config, providerNames: []})).toThrow()
  })

  describe('walletIcon', () => {
    const icon = 'data:image/svg+xml;base64,PHN2Zy8+'

    it('exposes the configured icon on every installed provider', () => {
      const registry = installProviders(generateInjectionScript({...config, walletIcon: icon}))
      for (const name of config.providerNames) {
        expect(registry[name]?.icon).toBe(icon)
        expect(registry[name]?.name).toBe('Pnyx')
      }
    })

    it('reports no icon rather than an empty string when none is configured', () => {
      // `icon: ''` would make a dApp render a broken <img>; CIP-30 wants the
      // field absent instead.
      const registry = installProviders(generateInjectionScript(config))
      expect(registry.pnyx?.icon).toBeUndefined()
      expect('icon' in (registry.pnyx ?? {})).toBe(true)
    })

    it('survives a data URI containing base64 padding and slashes', () => {
      const padded = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4+//8='
      const registry = installProviders(generateInjectionScript({...config, walletIcon: padded}))
      expect(registry.pnyx?.icon).toBe(padded)
    })
  })

  describe('extension transport', () => {
    const extConfig = {...config, transport: 'extension' as const}

    it('posts requests over window.postMessage instead of the WebView bridge', () => {
      const script = generateInjectionScript(extConfig)
      expect(script).toContain('window.postMessage({__pnyxDappRequest: message}, window.location.origin)')
      expect(script).not.toContain('window.ReactNativeWebView.postMessage')
    })

    it('installs a window message listener that feeds responses into the callback', () => {
      const script = generateInjectionScript(extConfig)
      expect(script).toContain("window.addEventListener('message'")
      expect(script).toContain('d.__pnyxDappResponse')
      expect(script).toContain(`window.${RESPONSE_CALLBACK}(d.__pnyxDappResponse)`)
    })

    it('keeps the shared CIP-30 surface and is syntactically valid', () => {
      const script = generateInjectionScript(extConfig)
      expect(script).toContain('window.cardano')
      expect(script).toContain("post('cardano'")
      expect(() => new Function(script)).not.toThrow()
    })
  })
})

describe('window.midnight', () => {
  it('installs one InitialAPI under the configured UUID', () => {
    const {registry} = runForMidnight(generateInjectionScript(config))

    // Keyed by UUID, not by wallet name — the Midnight registry follows the CAIP-372 draft.
    expect(Object.keys(registry)).toEqual([config.midnightUuid])
    const initial = registry[config.midnightUuid]
    expect(initial?.rdns).toBe('uk.pxkq.pnyx')
    expect(initial?.name).toBe('Pnyx')
    // The connector API version, not the wallet's own — dApps branch on it.
    expect(initial?.apiVersion).toBe('4.1.0')
    expect(typeof initial?.connect).toBe('function')
  })

  it('does not clobber another wallet already in the registry', () => {
    const script = generateInjectionScript(config)
    const posted: string[] = []
    const other = {rdns: 'com.other.wallet'}
    const fakeWindow: Record<string, unknown> = {
      ReactNativeWebView: {postMessage: (m: string) => posted.push(m)},
      location: {origin: 'https://dapp.example'},
      addEventListener: () => {},
      dispatchEvent: () => true,
      midnight: {'other-uuid': other},
    }
    new Function('window', 'setTimeout', 'clearTimeout', script)(
      fakeWindow,
      () => 0,
      () => {},
    )

    const registry = fakeWindow.midnight as Record<string, unknown>
    expect(registry['other-uuid']).toBe(other)
    expect(registry[config.midnightUuid]).toBeDefined()
  })

  it('tags its messages as midnight, so the resolver routes them to the right chain', async () => {
    const {registry, posted, respond} = runForMidnight(generateInjectionScript(config))

    void registry[config.midnightUuid]?.connect('preprod')
    const message = JSON.parse(posted[0] as string)

    expect(message.chainType).toBe('midnight')
    // `connect` is a real wire call, so the wallet decides authorisation and the network match. The
    // page reading the status itself would have handed out the API with nobody approving it.
    expect(message.method).toBe('connect')
    expect(message.params).toEqual(['preprod'])
    expect(message.origin).toBe('https://dapp.example')
    respond({id: message.id, result: {status: 'connected', networkId: 'preprod'}})
  })

  it('surfaces the wallet refusing a connection, rather than returning an API anyway', async () => {
    const {registry, posted, respond} = runForMidnight(generateInjectionScript(config))

    const connecting = registry[config.midnightUuid]?.connect('mainnet')
    // The wallet is what decides — network mismatch, or no approval. The page must not paper over it.
    respond({id: JSON.parse(posted[0] as string).id, error: {code: -1, message: 'this wallet is on preprod'}})

    await expect(connecting).rejects.toMatchObject({message: expect.stringContaining('preprod')})
  })

  it('restores balances to bigint, losing nothing past 2^53', async () => {
    const {registry, posted, respond} = runForMidnight(generateInjectionScript(config))
    const connecting = registry[config.midnightUuid]?.connect('preprod')
    respond({id: JSON.parse(posted[0] as string).id, result: {status: 'connected', networkId: 'preprod'}})
    const api = await connecting

    const reading = api?.getUnshieldedBalances()
    respond({id: JSON.parse(posted[1] as string).id, result: {night: '9007199254740993'}})

    // The wire carries decimal strings because JSON cannot hold a bigint and a Number would round to
    // ...992. The API promises the dApp bigints, so the conversion happens here or nowhere.
    await expect(reading).resolves.toEqual({night: 9_007_199_254_740_993n})
  })

  it('restores the DUST cap and balance to bigint', async () => {
    const {registry, posted, respond} = runForMidnight(generateInjectionScript(config))
    const connecting = registry[config.midnightUuid]?.connect('preprod')
    respond({id: JSON.parse(posted[0] as string).id, result: {status: 'connected', networkId: 'preprod'}})
    const api = await connecting

    const reading = api?.getDustBalance()
    respond({id: JSON.parse(posted[1] as string).id, result: {cap: '5000', balance: '1234'}})

    await expect(reading).resolves.toEqual({cap: 5_000n, balance: 1_234n})
  })

  it('refuses a Number amount rather than passing on a rounded balance', async () => {
    const {registry, posted, respond} = runForMidnight(generateInjectionScript(config))
    const connecting = registry[config.midnightUuid]?.connect('preprod')
    respond({id: JSON.parse(posted[0] as string).id, result: {status: 'connected', networkId: 'preprod'}})
    const api = await connecting

    const reading = api?.getUnshieldedBalances()
    respond({id: JSON.parse(posted[1] as string).id, result: {night: 9007199254740993}})

    // A Number has already lost precision by the time it arrives; a silently wrong balance is worse
    // than a failed call. `InternalError` because the wallet, not the page, sent something unusable.
    await expect(reading).rejects.toMatchObject({type: 'DAppConnectorAPIError', code: 'InternalError'})
  })

  it('presents every method the spec declares, so a dApp typed against the SDK is satisfied', async () => {
    const {registry, posted, respond} = runForMidnight(generateInjectionScript(config))
    const connecting = registry[config.midnightUuid]?.connect('preprod')
    respond({id: JSON.parse(posted[0] as string).id, result: {status: 'connected', networkId: 'preprod'}})
    const api = await connecting

    // Nothing is omitted: the spec marks no method of ConnectedAPI optional, so a dApp typed against
    // the SDK expects all of them. Two of these answer by refusing with a stated reason, which is an
    // answer — the thing to avoid is a declared method with no handler behind it at all.
    for (const present of [
      'balanceSealedTransaction',
      'makeIntent',
      'getUnshieldedAddress',
      'getDustBalance',
      'signData',
      'hintUsage',
      'makeTransfer',
      'balanceUnsealedTransaction',
      'submitTransaction',
      'getProvingProvider',
    ]) {
      expect(typeof api?.[present]).toBe('function')
    }
  })
})

describe('window.midnight — what it declares is what the wallet answers', () => {
  /**
   * A context whose values are never read: this test compares *method names*, so the effects only have
   * to exist. Anything the handler prices at build time (each `Effect` is a value in its method map)
   * must still be present, which is why the fields are spelled out rather than cast.
   */
  const context: MidnightHandlerContext = {
    unshieldedAddress: Effect.succeed('mn_addr_preprod1abc'),
    dustAddress: Effect.succeed('mn_dust1abc'),
    shieldedAddresses: Effect.succeed({
      shieldedAddress: 'mn_shield-addr_preprod1abc',
      shieldedCoinPublicKey: 'mn_shield-cpk_preprod1abc',
      shieldedEncryptionPublicKey: 'mn_shield-epk_preprod1abc',
    }),
    unshieldedBalances: Effect.succeed({}),
    shieldedBalances: Effect.succeed({}),
    checkPreimage: () => Effect.succeed([]),
    proveCircuit: () => Effect.succeed(new Uint8Array()),
    dustBalance: Effect.succeed({cap: 0n, balance: 0n}),
    configuration: Effect.succeed({
      indexerUri: 'https://indexer.example/api/v4/graphql',
      indexerWsUri: 'wss://indexer.example/api/v4/graphql/ws',
      substrateNodeUri: 'https://rpc.example',
      networkId: 'preprod',
    }),
    connectionStatus: Effect.succeed({status: 'connected', networkId: 'preprod'}),
    txHistory: () => Effect.succeed([]),
    hintUsage: () => Effect.void,
  }

  it('declares exactly the methods the resolver handles', async () => {
    // ⚠️ The defect this pins: `getShieldedBalances` was declared on the injected API (and so appeared
    // in the `methods` list a dApp feature-detects on) while the resolver had no handler for it, so
    // every call threw "not supported". Declaring a method is a promise to answer it.
    const {registry, posted, respond} = runForMidnight(generateInjectionScript(config))
    const connecting = registry[config.midnightUuid]?.connect('preprod')
    respond({id: JSON.parse(posted[0] as string).id, result: {status: 'connected', networkId: 'preprod'}})
    const api = await connecting

    const declared = Object.keys(api ?? {}).sort()
    /**
     * Methods the resolver serves that are **not** page-facing API surface.
     *
     * `connect` lives on the initial API — it is what returns the object above. The two proving calls
     * are the wire behind one API method: `getProvingProvider` returns an object whose `check` and
     * `prove` live in the page, because the API's `KeyMaterialProvider` argument cannot cross a JSON
     * bridge, and each of its calls becomes one of these. Keeping the list explicit is the point: a
     * *new* handler method that is not on it, and not declared, is the bug this test exists for.
     */
    const wireOnly = new Set(['connect', 'provingProviderCheck', 'provingProviderProve'])
    const handled = [...createMidnightHandler(context, () => Effect.succeed(true)).methods.keys()]
      .filter((method) => !wireOnly.has(method))
      .sort()

    expect(declared).toEqual(handled)
  })
})

describe("window.midnight — errors are the API's own shape", () => {
  const connected = async () => {
    const {registry, posted, respond} = runForMidnight(generateInjectionScript(config))
    const connecting = registry[config.midnightUuid]?.connect('preprod')
    respond({id: JSON.parse(posted[0] as string).id, result: {status: 'connected', networkId: 'preprod'}})
    return {api: await connecting, posted, respond}
  }

  it('carries the type discriminator, the string code and the reason', async () => {
    const {api, posted, respond} = await connected()

    const reading = api?.getUnshieldedAddress?.()
    respond({
      id: JSON.parse(posted[1] as string).id,
      error: {code: -3, message: 'not connected', apiCode: 'PermissionRejected'},
    })

    // The spec's APIError: `type` is what a dApp discriminates on, `code` is a string from a six-value
    // union, `reason` is the text. A numeric CIP-30 code matches none of that, and a dApp branching on
    // ErrorCodes.PermissionRejected would see nothing.
    await expect(reading).rejects.toMatchObject({
      type: 'DAppConnectorAPIError',
      code: 'PermissionRejected',
      reason: 'not connected',
    })
    await expect(reading).rejects.toBeInstanceOf(Error)
  })

  it('falls back to the numeric code only when the host names none', async () => {
    const {api, posted, respond} = await connected()

    const reading = api?.getUnshieldedAddress?.()
    respond({id: JSON.parse(posted[1] as string).id, error: {code: -1, message: 'bad params'}})

    await expect(reading).rejects.toMatchObject({type: 'DAppConnectorAPIError', code: 'InvalidRequest'})
  })

  it('reports a verdict-less failure as InternalError rather than inventing one', async () => {
    const {api, posted, respond} = await connected()

    const reading = api?.getUnshieldedAddress?.()
    respond({id: JSON.parse(posted[1] as string).id, error: {message: 'something fell over'}})

    await expect(reading).rejects.toMatchObject({type: 'DAppConnectorAPIError', code: 'InternalError'})
  })
})
