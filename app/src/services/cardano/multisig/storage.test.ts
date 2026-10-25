import {XpubHex} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {
  getSharedWallet,
  listSharedWallets,
  newSharedWalletId,
  parseWallet,
  removeSharedWallet,
  renameSharedWallet,
  saveSharedWallet,
  serializeWallet,
} from './storage'
import {flatTemplate, tagAt, withTimeLock} from './template'
import type {SharedWallet} from './types'

/** In-memory Storage double — the platform layer is MMKV/native. */
const memoryStorage = () => {
  const map = new Map<string, string>()
  return {
    get: (k: string) => Effect.succeed(map.get(k) ?? null),
    set: (k: string, v: string) => Effect.sync(() => void map.set(k, v)),
    remove: (k: string) => Effect.sync(() => void map.delete(k)),
    keys: () => Effect.succeed([...map.keys()]),
    clear: () => Effect.sync(() => map.clear()),
    // biome-ignore lint/suspicious/noExplicitAny: structural double for the Storage port
  } as any
}

const wallet = (over: Partial<SharedWallet> = {}): SharedWallet => {
  const coSigners = [
    {tag: tagAt(0), name: 'Alice', accountXpubHex: XpubHex('aa'.repeat(64)), isSelf: true},
    {tag: tagAt(1), name: 'Bob', accountXpubHex: XpubHex('bb'.repeat(64))},
  ]
  const t = flatTemplate(
    {kind: 'all'},
    coSigners.map((c) => c.tag),
  )
  return {
    id: 'w1',
    name: 'Treasury',
    coSigners,
    paymentTemplate: t,
    delegationTemplate: t,
    network: Address.Network.Testnet,
    accountIndex: 0,
    createdAt: '2026-08-08T00:00:00.000Z',
    ...over,
  }
}

describe('serialize / parse', () => {
  it('round-trips a wallet', () => {
    const w = wallet()
    expect(parseWallet(serializeWallet(w))).toEqual(w)
  })

  it('round-trips bigint slots as strings, losslessly', () => {
    // JSON.stringify throws on bigint, and a slot past 2^53 would lose precision
    // as a number — so slots are stored as decimal strings.
    const huge = 9_007_199_254_740_993n // 2^53 + 1
    const t = withTimeLock(flatTemplate({kind: 'all'}, [tagAt(0)]), {from: huge, until: huge + 5n})
    const w = wallet({paymentTemplate: t, delegationTemplate: t})
    const parsed = parseWallet(serializeWallet(w))
    expect(parsed).toEqual(w)
    expect(JSON.stringify(serializeWallet(w))).toContain('9007199254740993')
  })

  it('rejects a record with an empty roster', () => {
    // Would compile to a script with no signature requirement at all.
    const raw = serializeWallet(wallet()).replace(/"coSigners":\[.*?\]/, '"coSigners":[]')
    expect(parseWallet(raw)).toBeNull()
  })

  it('rejects a co-signer missing its xpub', () => {
    const raw = serializeWallet(wallet()).replace(/"accountXpubHex":"a+"/, '"accountXpubHex":null')
    expect(parseWallet(raw)).toBeNull()
  })

  it('rejects a stored template that is not one, rather than reviving it blind', () => {
    // A record half-written or hand-edited used to be trusted structurally: the
    // reader rebuilt whatever it found, and a wrong template compiles to a wrong
    // spending rule — the one failure nobody sees until funds are in the wallet.
    const raw = serializeWallet(wallet())
    expect(
      parseWallet(
        raw.replace(
          /"paymentTemplate":\{.*?\},"delegationTemplate"/,
          '"paymentTemplate":{"kind":"nope"},"delegationTemplate',
        ),
      ),
    ).toBeNull()
    expect(parseWallet(raw.replace('"kind":"cosigner"', '"kind":"unknown-node"'))).toBeNull()
  })

  it('rejects malformed JSON and non-objects', () => {
    expect(parseWallet('{oops')).toBeNull()
    expect(parseWallet('null')).toBeNull()
    expect(parseWallet('"a string"')).toBeNull()
  })
})

describe('registry', () => {
  const run = <A>(e: Effect.Effect<A, unknown>) => Effect.runPromise(e as Effect.Effect<A>)

  it('saves and reads back within a network', async () => {
    const s = memoryStorage()
    const w = wallet()
    await run(saveSharedWallet(s, w))
    expect(await run(getSharedWallet(s, Address.Network.Testnet, 'w1'))).toEqual(w)
  })

  it('scopes the list by network', async () => {
    // The old registry keyed by address alone, so preprod wallets showed up on
    // mainnet and every "do I have one?" gate lit up on the wrong network.
    const s = memoryStorage()
    await run(saveSharedWallet(s, wallet({id: 'test-1', network: Address.Network.Testnet})))
    await run(saveSharedWallet(s, wallet({id: 'main-1', network: Address.Network.Mainnet})))
    expect((await run(listSharedWallets(s, Address.Network.Testnet))).map((w) => w.id)).toEqual(['test-1'])
    expect((await run(listSharedWallets(s, Address.Network.Mainnet))).map((w) => w.id)).toEqual(['main-1'])
  })

  it('sorts oldest first', async () => {
    const s = memoryStorage()
    await run(saveSharedWallet(s, wallet({id: 'b', createdAt: '2026-08-08T10:00:00.000Z'})))
    await run(saveSharedWallet(s, wallet({id: 'a', createdAt: '2026-08-07T10:00:00.000Z'})))
    expect((await run(listSharedWallets(s, Address.Network.Testnet))).map((w) => w.id)).toEqual(['a', 'b'])
  })

  it('removes only the addressed wallet', async () => {
    const s = memoryStorage()
    await run(saveSharedWallet(s, wallet({id: 'a'})))
    await run(saveSharedWallet(s, wallet({id: 'b'})))
    await run(removeSharedWallet(s, Address.Network.Testnet, 'a'))
    expect((await run(listSharedWallets(s, Address.Network.Testnet))).map((w) => w.id)).toEqual(['b'])
  })

  it('skips unparseable records rather than failing the list', async () => {
    const s = memoryStorage()
    await run(saveSharedWallet(s, wallet({id: 'good'})))
    await run(s.set('cardano.multisig.0.corrupt', '{oops'))
    expect((await run(listSharedWallets(s, Address.Network.Testnet))).map((w) => w.id)).toEqual(['good'])
  })

  it('returns null for an id that is not there', async () => {
    expect(await run(getSharedWallet(memoryStorage(), Address.Network.Testnet, 'nope'))).toBeNull()
  })

  it('renames a wallet held on either network, not just the active one', async () => {
    // The record is network-keyed and the wallet *group* is not, so a rename can
    // arrive while the app sits on the other network. Reading only one left the
    // registry holding the old name — the name a re-share sends and a publish
    // writes on chain.
    const s = memoryStorage()
    await run(saveSharedWallet(s, wallet({id: 'on-testnet', network: Address.Network.Testnet})))
    await run(saveSharedWallet(s, wallet({id: 'on-mainnet', network: Address.Network.Mainnet})))

    expect(await run(renameSharedWallet(s, 'on-mainnet', 'House money'))).toBe(true)
    expect(await run(renameSharedWallet(s, 'on-testnet', 'Rent pot'))).toBe(true)

    expect((await run(getSharedWallet(s, Address.Network.Mainnet, 'on-mainnet')))?.name).toBe('House money')
    expect((await run(getSharedWallet(s, Address.Network.Testnet, 'on-testnet')))?.name).toBe('Rent pot')
  })

  it('reports false for an id that is not a shared wallet, and changes nothing', async () => {
    const s = memoryStorage()
    await run(saveSharedWallet(s, wallet()))
    expect(await run(renameSharedWallet(s, 'an-ordinary-group', 'Nope'))).toBe(false)
    expect((await run(getSharedWallet(s, Address.Network.Testnet, 'w1')))?.name).toBe('Treasury')
  })

  it('keeps everything but the name', async () => {
    const s = memoryStorage()
    const original = wallet()
    await run(saveSharedWallet(s, original))
    await run(renameSharedWallet(s, 'w1', 'Renamed'))
    const after = await run(getSharedWallet(s, Address.Network.Testnet, 'w1'))
    expect(after).toEqual({...original, name: 'Renamed'})
  })
})

describe('newSharedWalletId', () => {
  it('does not collide within a tick', () => {
    const ids = new Set(Array.from({length: 50}, newSharedWalletId))
    expect(ids.size).toBe(50)
  })
})
