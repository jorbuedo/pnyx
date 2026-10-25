import {Cip129} from '@evolution-sdk/cips'
import {Effect} from 'effect'
import {beforeEach, describe, expect, it} from 'vitest'
import {getPoolDRepConfig} from './config'
import {fetchDRepInfo, fetchDRepList, resetActiveDRepCache, resetKoiosDRepListCache} from './drep'
import {hexToBytes} from './http'
import {fetchPoolInfo, fetchPoolList, resetPoolListCache} from './pool'

const MAINNET = getPoolDRepConfig('mainnet')
const PREPROD = getPoolDRepConfig('preprod')

const run = <A>(e: Effect.Effect<A>) => Effect.runPromise(e)

/** Route by URL substring; record every requested URL for call-site assertions. */
const makeStub = (routes: Record<string, unknown>) => {
  const calls: string[] = []
  const fetchImpl = (url: string) => {
    calls.push(url)
    const key = Object.keys(routes).find((k) => url.includes(k))
    return Promise.resolve({
      ok: key !== undefined,
      status: key !== undefined ? 200 : 404,
      json: async () => (key !== undefined ? routes[key] : []),
    })
  }
  return {fetchImpl, calls}
}

const poolEntry = (over: Record<string, unknown> = {}) => ({
  pool_id: 'pool1abc',
  pool_id_hash_raw: 'deadbeef',
  pool_name: {ticker: 'ABC', name: 'Alpha Pool', description: 'A pool', homepage: 'https://alpha.io'},
  pool_update: {active: {margin: 0.02, fixed_cost: '340000000', pledge: '1000000000000'}, live: {margin: 0.05}},
  saturation: 0.7,
  live_stake: '5000000',
  delegators: 42,
  pool_retire: {active: {retiring_epoch: null}},
  ...over,
})

const envelope = (entries: unknown[]) => ({code: 200, data: {data: entries}})
/** The R2 slow-data blob wrapper the data worker writes: `{updatedAt, data}`. */
const blob = (data: unknown) => ({updatedAt: '2026-07-18T05:00:00Z', data})

describe('fetchPoolInfo', () => {
  beforeEach(() => resetPoolListCache())

  it('resolves a PoolInfo from the R2 pool list (ticker/name/logo/status/margin/pledge)', async () => {
    const {fetchImpl} = makeStub({'pools.json': blob(envelope([poolEntry()]))})
    const info = await run(fetchPoolInfo('pool1abc', MAINNET, fetchImpl))
    expect(info).toMatchObject({
      id: 'pool1abc',
      idHex: 'deadbeef',
      ticker: 'ABC',
      name: 'Alpha Pool',
      description: 'A pool',
      homepage: 'https://alpha.io',
      margin: 0.02,
      pledge: 1000000000000n,
      saturation: 0.7,
      delegators: 42,
      status: 'active',
      logoUrl: 'https://ix.cexplorer.io/pool1abc',
    })
  })

  it("marks status 'retiring' when a retirement epoch is set", async () => {
    const {fetchImpl} = makeStub({
      'pools.json': blob(envelope([poolEntry({pool_retire: {active: {retiring_epoch: 500}}})])),
    })
    const info = await run(fetchPoolInfo('pool1abc', MAINNET, fetchImpl))
    expect(info?.status).toBe('retiring')
  })

  it('returns null for an unknown pool and when the list is unavailable', async () => {
    const known = makeStub({'pools.json': blob(envelope([poolEntry()]))})
    expect(await run(fetchPoolInfo('pool1nope', MAINNET, known.fetchImpl))).toBeNull()
    resetPoolListCache()
    const down = makeStub({}) // no route → 404 → list null
    expect(await run(fetchPoolInfo('pool1abc', MAINNET, down.fetchImpl))).toBeNull()
  })

  it('matches by bech32 id or by hex key-hash', async () => {
    const {fetchImpl} = makeStub({'pools.json': blob(envelope([poolEntry()]))})
    expect((await run(fetchPoolInfo('pool1abc', MAINNET, fetchImpl)))?.id).toBe('pool1abc')
    expect((await run(fetchPoolInfo('deadbeef', MAINNET, fetchImpl)))?.id).toBe('pool1abc')
  })

  it('reads the R2 blob, never a direct upstream (no cexplorer-pool-list call)', async () => {
    const {fetchImpl, calls} = makeStub({'pools.json': blob(envelope([poolEntry()]))})
    await run(fetchPoolInfo('pool1abc', MAINNET, fetchImpl))
    expect(calls.every((u) => u.includes('/pools.json'))).toBe(true)
    expect(calls.some((u) => u.includes('cexplorer-pool-list'))).toBe(false)
  })
})

// A 28-byte credential hash (key + script variants) and their CIP-129 drep ids.
const KEY_HEX = 'ab'.repeat(28)
const SCRIPT_HEX = 'cd'.repeat(28)
const KEY_DREP = Cip129.drepBech32(hexToBytes(KEY_HEX), false)
const SCRIPT_DREP = Cip129.drepBech32(hexToBytes(SCRIPT_HEX), true)

const activeEntry = (over: Record<string, unknown> = {}) => ({
  id: KEY_HEX,
  from: 'key',
  metadataVerification: 'verified',
  metadata: {givenName: {'@value': 'Alice'}, image: {contentUrl: 'https://img/alice'}},
  stake: '1234',
  ...over,
})

const koiosRow = (over: Record<string, unknown> = {}) => ({
  drep_id: KEY_DREP,
  hex: KEY_HEX,
  has_script: false,
  registered: true,
  active: true,
  deposit: '500000000',
  amount: '9999',
  anchor_url: 'https://anchor.example',
  anchor_hash: 'aa',
  ...over,
})

describe('fetchDRepInfo', () => {
  beforeEach(() => resetActiveDRepCache())

  it('produces a valid CIP-129 bech32 for key vs script (distinct ids)', () => {
    expect(KEY_DREP.startsWith('drep1')).toBe(true)
    expect(SCRIPT_DREP.startsWith('drep1')).toBe(true)
    expect(KEY_DREP).not.toBe(SCRIPT_DREP)
    expect(Cip129.parseCredential(SCRIPT_DREP)?.isScript).toBe(true)
    expect(Cip129.parseCredential(KEY_DREP)?.isScript).toBe(false)
  })

  it('merges R2 givenName + verified image with Koios on-chain state (mainnet)', async () => {
    const {fetchImpl} = makeStub({'dreps.json': blob([activeEntry()]), drep_info: [koiosRow()]})
    const info = await run(fetchDRepInfo(KEY_DREP, MAINNET, fetchImpl))
    expect(info).toMatchObject({
      id: KEY_DREP,
      idHex: KEY_HEX,
      isScript: false,
      givenName: 'Alice',
      imageUrl: 'https://img/alice',
      registered: true,
      active: true,
      votingPower: 9999n, // Koios `amount` wins over the list `stake`
      anchorUrl: 'https://anchor.example',
      anchorHash: 'aa',
    })
  })

  it('unwraps a bare-string givenName and drops the image when not verified', async () => {
    const {fetchImpl} = makeStub({
      'dreps.json': blob([
        activeEntry({
          metadata: {givenName: 'Bob', image: {contentUrl: 'https://img/bob'}},
          metadataVerification: 'unverified',
        }),
      ]),
    })
    const info = await run(fetchDRepInfo(KEY_DREP, MAINNET, fetchImpl))
    expect(info?.givenName).toBe('Bob')
    expect(info?.imageUrl).toBeUndefined()
    expect(info?.votingPower).toBe(1234n) // no Koios → list stake is the fallback voting power
  })

  it('resolves the script-hash id and sets isScript', async () => {
    const {fetchImpl} = makeStub({
      'dreps.json': blob([activeEntry({id: SCRIPT_HEX, from: 'script'})]),
      drep_info: [koiosRow({drep_id: SCRIPT_DREP, hex: SCRIPT_HEX, has_script: true})],
    })
    const info = await run(fetchDRepInfo(SCRIPT_DREP, MAINNET, fetchImpl))
    expect(info).toMatchObject({id: SCRIPT_DREP, idHex: SCRIPT_HEX, isScript: true, registered: true})
  })

  it('falls back to Koios-only on a non-mainnet network (no name, no list call)', async () => {
    const {fetchImpl, calls} = makeStub({drep_info: [koiosRow()]})
    const info = await run(fetchDRepInfo(KEY_DREP, PREPROD, fetchImpl))
    expect(info).toMatchObject({id: KEY_DREP, idHex: KEY_HEX, registered: true, active: true, votingPower: 9999n})
    expect(info?.givenName).toBeUndefined()
    expect(calls.some((u) => u.includes('dreps.json'))).toBe(false)
  })

  it('returns null (no fetch) for an unparseable / non-DRep id', async () => {
    const {fetchImpl, calls} = makeStub({drep_info: [koiosRow()], 'dreps.json': blob([activeEntry()])})
    expect(await run(fetchDRepInfo('not-a-drep-id', MAINNET, fetchImpl))).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('returns null when neither tier resolves anything', async () => {
    const {fetchImpl} = makeStub({}) // every route 404s
    expect(await run(fetchDRepInfo(KEY_DREP, MAINNET, fetchImpl))).toBeNull()
  })
})

describe('fetchPoolList', () => {
  beforeEach(() => resetPoolListCache())

  it('parses the full list incl. picker metrics (roa/fixedCost/blocksLastEpoch/liveStake)', async () => {
    const entry = poolEntry({
      stats: {recent: {roa: 3.2}, lifetime: {roa: 2.8}},
      epochs: {'0': {no: 500, data: {block: {minted: 12}}}},
    })
    const {fetchImpl} = makeStub({'pools.json': blob(envelope([entry, {no_id: true}]))})
    const pools = await run(fetchPoolList(MAINNET, fetchImpl))
    expect(pools).toHaveLength(1)
    expect(pools?.[0]).toMatchObject({
      id: 'pool1abc',
      roa: 3.2,
      fixedCost: 340000000n,
      blocksLastEpoch: 12,
      liveStake: 5000000n,
    })
  })

  it('falls back to lifetime ROA when recent is null', async () => {
    const entry = poolEntry({stats: {recent: {roa: null}, lifetime: {roa: 2.8}}})
    const {fetchImpl} = makeStub({'pools.json': blob(envelope([entry]))})
    const pools = await run(fetchPoolList(MAINNET, fetchImpl))
    expect(pools?.[0]?.roa).toBe(2.8)
  })

  it('caches the list (one read for two calls) and resolves null when R2 is unavailable', async () => {
    const {fetchImpl, calls} = makeStub({'pools.json': blob(envelope([poolEntry()]))})
    await run(fetchPoolList(MAINNET, fetchImpl))
    await run(fetchPoolList(MAINNET, fetchImpl))
    expect(calls).toHaveLength(1)

    resetPoolListCache()
    const failing = makeStub({}) // 404 → null (no direct fallback)
    expect(await run(fetchPoolList(MAINNET, failing.fetchImpl))).toBeNull()
  })

  it('returns null on testnet (no R2 list source) without any fetch', async () => {
    const {fetchImpl, calls} = makeStub({'pools.json': blob(envelope([poolEntry()]))})
    expect(await run(fetchPoolList(PREPROD, fetchImpl))).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

describe('fetchDRepList', () => {
  beforeEach(() => {
    resetActiveDRepCache()
    resetKoiosDRepListCache()
  })

  const HASH_HEX = 'a5b45515a3ff8cb7c02ce351834da324eb6dfc41b5779cb5e6b832aa'
  const CIP129_ID = Cip129.drepBech32(hexToBytes(HASH_HEX), false)

  it('mainnet: maps the R2 active list to entries (name, power, delegators)', async () => {
    const {fetchImpl} = makeStub({
      'dreps.json': blob([
        {
          id: HASH_HEX,
          from: 'key',
          stake: '77000000',
          delegatorCount: 9,
          metadataVerification: 'verified',
          metadata: {givenName: {'@value': 'Ada Guild'}, image: {contentUrl: 'https://img.example/x.png'}},
        },
      ]),
    })
    const list = await run(fetchDRepList(MAINNET, fetchImpl))
    expect(list).toHaveLength(1)
    expect(list?.[0]).toMatchObject({
      id: CIP129_ID,
      idHex: HASH_HEX,
      isScript: false,
      givenName: 'Ada Guild',
      imageUrl: 'https://img.example/x.png',
      votingPower: 77000000n,
      delegators: 9,
    })
  })

  it('mainnet: an empty read is an outage → null, and is NOT pinned in the cache', async () => {
    const failing = makeStub({})
    expect(await run(fetchDRepList(MAINNET, failing.fetchImpl))).toBeNull()
    // Backend recovers — next read must refetch, not replay the failure.
    const {fetchImpl} = makeStub({'dreps.json': blob([{id: HASH_HEX, from: 'key'}])})
    expect(await run(fetchDRepList(MAINNET, fetchImpl))).toHaveLength(1)
  })

  it('testnet: pulls Koios drep_list (registered only) and enriches via one drep_info batch', async () => {
    const {fetchImpl, calls} = makeStub({
      drep_list: [
        {drep_id: CIP129_ID, hex: HASH_HEX, has_script: false, registered: true},
        {drep_id: 'drep1unregistered', hex: 'ff', has_script: false, registered: false},
      ],
      drep_info: [{drep_id: CIP129_ID, amount: '123', active: true}],
    })
    const list = await run(fetchDRepList(PREPROD, fetchImpl))
    expect(list).toHaveLength(1)
    expect(list?.[0]).toMatchObject({id: CIP129_ID, idHex: HASH_HEX, votingPower: 123n, active: true})
    expect(calls.filter((u) => u.includes('drep_info'))).toHaveLength(1)
    // second read served from cache
    await run(fetchDRepList(PREPROD, fetchImpl))
    expect(calls.filter((u) => u.includes('drep_list'))).toHaveLength(1)
  })
})
