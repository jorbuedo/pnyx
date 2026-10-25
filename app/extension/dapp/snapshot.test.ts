import {type CardanoHandlerContext, type DappMessage, makeInMemorySessionStore} from '@pnyx/dapp-connector'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {createDappRouter} from './router'
import {makeSessionPort} from './session-port'
import {contextToSnapshot} from './snapshot'

const ADDR = `01${'11'.repeat(28)}${'22'.repeat(28)}`

// A fake app-side context, shaped like createCardanoHandlerContext's output.
const fakeContext = (withGovKeys: boolean): CardanoHandlerContext => ({
  networkId: Effect.succeed(1),
  networkMagic: Effect.succeed(764824073),
  utxos: Effect.succeed([
    {txHashHex: 'ab'.repeat(32), index: 0, addressHex: ADDR, coin: 2_000_000n, assets: []},
    {
      txHashHex: 'cd'.repeat(32),
      index: 1,
      addressHex: ADDR,
      coin: 5_000_000n,
      assets: [{policyHex: 'ff'.repeat(28), nameHex: '41', quantity: 42n}],
    },
  ]),
  collateralUtxos: Effect.succeed([]),
  changeAddressHex: Effect.succeed(ADDR),
  usedAddressHexes: Effect.succeed([ADDR]),
  unusedAddressHexes: Effect.succeed([]),
  rewardAddressHexes: Effect.succeed([`e1${'22'.repeat(28)}`]),
  submitTx: () => Effect.succeed('txhash'),
  pubDRepKeyHex: withGovKeys ? Effect.succeed('00'.repeat(32)) : Effect.fail({} as never),
  registeredPubStakeKeyHexes: withGovKeys ? Effect.succeed([]) : Effect.fail({} as never),
  unregisteredPubStakeKeyHexes: withGovKeys ? Effect.succeed(['11'.repeat(32)]) : Effect.fail({} as never),
})

describe('contextToSnapshot', () => {
  it('serializes bigints to strings and includes CIP-95 keys when present', async () => {
    const snap = await contextToSnapshot(fakeContext(true), 'group-1', 0)
    expect(snap.networkId).toBe(1)
    expect(snap.utxos[0]?.coin).toBe('2000000')
    expect(snap.utxos[1]?.assets[0]).toEqual({policyHex: 'ff'.repeat(28), nameHex: '41', quantity: '42'})
    expect(snap.pubDRepKeyHex).toBe('00'.repeat(32))
    // JSON-safe (no bigints).
    expect(() => JSON.stringify(snap)).not.toThrow()
  })

  it('omits CIP-95 fields when the gov keys are not derived', async () => {
    const snap = await contextToSnapshot(fakeContext(false), 'group-1', 0)
    expect(snap.pubDRepKeyHex).toBeUndefined()
    expect(snap.unregisteredPubStakeKeyHexes).toBeUndefined()
    expect(snap.utxos).toHaveLength(2)
  })

  it('round-trips through the router: app context → snapshot → SW read → CBOR', async () => {
    const snap = await contextToSnapshot(fakeContext(true), 'group-1', 0)
    const sessions = makeSessionPort(makeInMemorySessionStore())
    const origin = 'https://dapp.example'
    await Effect.runPromise(sessions.connect(origin, 'group-1', 0, null))
    const router = createDappRouter({
      loadSnapshot: () => Effect.succeed(snap),
      sessions,
      broadcast: () => {},
      submitTx: () => Effect.succeed('h'),
    })
    const msg = (method: string): DappMessage => ({
      id: 'x:1',
      sessionId: 'x',
      chainType: 'cardano',
      method,
      params: undefined,
      origin,
    })
    const balance = await router.handle(msg('getBalance'), origin)
    // Multi-asset Value: array(2) of 7 ADA (1a006acfc0) + the token map.
    expect(balance.result).toBe('821a006acfc0a1581cffffffffffffffffffffffffffffffffffffffffffffffffffffffffa14141182a')
    const used = await router.handle(msg('getUsedAddresses'), origin)
    expect(used.result).toEqual([ADDR])
  })
})
