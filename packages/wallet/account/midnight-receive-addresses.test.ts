import {MemoryAddressTable} from '@pnyx/store/address-table.memory'
import {Effect} from 'effect'
import {beforeEach, describe, expect, it} from 'vitest'
import {encodeNightAddress} from './derivation/midnight-address-encoding.js'
import {
  getStoredMidnightReceiveAddress,
  MIDNIGHT_RECEIVE_ADDRESS_SLOTS,
  type MidnightAddressStore,
  midnightAddressStoreKey,
  midnightNetworkIdForNetwork,
  persistMidnightReceiveAddresses,
} from './midnight-receive-addresses.js'

// Same fixture + golden vectors as ./derivation/midnight.test.ts (captured
// against the real @midnight-ntwrk SDK).
const TEST_MNEMONIC = 'test test test test test test test test test test test junk'

const EXPECTED = {
  night: 'mn_addr1lhm2myd3rwe672fs3hsw2nc9t4wvkhtst7fq75jtlh7674a3reqspywdyd',
  dust: 'mn_dust1wdkdudaenm0zef20rvgnacmpmrqy9xjjn8q0rjh3j6q2nreq3jyxvv8fu09',
  shielded:
    'mn_shield-addr1j79fwduuxrpphd7v3flqufr6slsquc3laz5xcv0vn2ft23p4k6vnvh3vy3ckjx9leyts2yc3mak23suejz47je5dh9n5c9zfsagrm0gtahmdd',
} as const

const REF = {groupId: 'group-1', chainId: 'midnight:mainnet', accountIndex: 0}

describe('midnight receive-address persistence', () => {
  let store: MidnightAddressStore & {
    list: (query: {groupId?: string}) => Effect.Effect<readonly unknown[], unknown>
  }

  beforeEach(async () => {
    const table = await Effect.runPromise(MemoryAddressTable)
    store = {get: table.get, upsertMany: table.upsertMany, list: table.list}
  })

  it('derives from the mnemonic and persists the full set into the fixed single-branch slots', async () => {
    const written = await Effect.runPromise(
      persistMidnightReceiveAddresses({store, ref: REF, mnemonic: TEST_MNEMONIC, networkIds: ['mainnet']}),
    )
    expect(written).toEqual(['mainnet'])

    const scoped = {...REF, chainId: midnightAddressStoreKey('mainnet')}
    for (const kind of ['night', 'dust', 'shielded'] as const) {
      const row = await Effect.runPromise(store.get(scoped, 'single', MIDNIGHT_RECEIVE_ADDRESS_SLOTS[kind]))
      expect(row).toMatchObject({human: EXPECTED[kind], hash: EXPECTED[kind], isUsed: false, branch: 'single'})
    }
  })

  it('serves the stored night address as the receive address', async () => {
    await Effect.runPromise(
      persistMidnightReceiveAddresses({store, ref: REF, mnemonic: TEST_MNEMONIC, networkIds: ['mainnet']}),
    )
    expect(await Effect.runPromise(getStoredMidnightReceiveAddress(store, REF, 'mainnet'))).toBe(EXPECTED.night)
  })

  it('is idempotent per network — a second persist writes nothing', async () => {
    await Effect.runPromise(
      persistMidnightReceiveAddresses({store, ref: REF, mnemonic: TEST_MNEMONIC, networkIds: ['mainnet']}),
    )
    const second = await Effect.runPromise(
      persistMidnightReceiveAddresses({store, ref: REF, mnemonic: TEST_MNEMONIC, networkIds: ['mainnet']}),
    )
    expect(second).toEqual([])
  })

  /**
   * The defect this keying exists for: the rows used to be written once, for whichever
   * network was active, into a per-network database — so switching network lost them
   * for good, with no seed left to re-derive from.
   */
  it('keeps every network separate, each with its own HRP', async () => {
    const written = await Effect.runPromise(
      persistMidnightReceiveAddresses({
        store,
        ref: REF,
        mnemonic: TEST_MNEMONIC,
        networkIds: ['mainnet', 'preprod', 'preview'],
      }),
    )
    expect(written).toEqual(['mainnet', 'preprod', 'preview'])

    expect(await Effect.runPromise(getStoredMidnightReceiveAddress(store, REF, 'mainnet'))).toMatch(/^mn_addr1/)
    expect(await Effect.runPromise(getStoredMidnightReceiveAddress(store, REF, 'preprod'))).toMatch(/^mn_addr_preprod1/)
    expect(await Effect.runPromise(getStoredMidnightReceiveAddress(store, REF, 'preview'))).toMatch(/^mn_addr_preview1/)
  })

  it('reads one network without being confused by another that is stored', async () => {
    await Effect.runPromise(
      persistMidnightReceiveAddresses({store, ref: REF, mnemonic: TEST_MNEMONIC, networkIds: ['mainnet']}),
    )
    // mainnet is present, preprod is not: the read must say so rather than serve the
    // mainnet row, which the preprod indexer would reject outright.
    const exit = await Effect.runPromiseExit(getStoredMidnightReceiveAddress(store, REF, 'preprod'))
    expect(exit._tag).toBe('Failure')
  })

  it('backfills only the networks that are missing', async () => {
    await Effect.runPromise(
      persistMidnightReceiveAddresses({store, ref: REF, mnemonic: TEST_MNEMONIC, networkIds: ['mainnet']}),
    )
    const written = await Effect.runPromise(
      persistMidnightReceiveAddresses({
        store,
        ref: REF,
        mnemonic: TEST_MNEMONIC,
        networkIds: ['mainnet', 'preprod', 'preview'],
      }),
    )
    expect(written).toEqual(['preprod', 'preview'])
  })

  it("ignores the caller's chainId — the network alone decides the key", async () => {
    await Effect.runPromise(
      persistMidnightReceiveAddresses({
        store,
        ref: {...REF, chainId: 'cardano:mainnet'},
        mnemonic: TEST_MNEMONIC,
        networkIds: ['preprod'],
      }),
    )
    expect(await Effect.runPromise(getStoredMidnightReceiveAddress(store, REF, 'preprod'))).toMatch(/^mn_addr_preprod1/)
  })

  it('fails with a typed DerivationError when nothing is stored (no xpub fallback)', async () => {
    const exit = await Effect.runPromiseExit(getStoredMidnightReceiveAddress(store, REF, 'mainnet'))
    expect(exit._tag).toBe('Failure')
    if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
      expect(exit.cause.error).toMatchObject({_tag: 'DerivationError'})
      expect(String(exit.cause.error.message)).toContain('not stored for mainnet')
    } else {
      expect.unreachable('expected a Fail cause')
    }
  })

  it('maps the wallet network onto the Midnight network id', () => {
    // Every one of our network names is also a Midnight network id, so this is identity.
    // Collapsing preprod onto `testnet` produced addresses the preprod indexer rejects
    // ("expected HRP mn_addr_preprod"), which is why the mapping is pinned here.
    expect(midnightNetworkIdForNetwork('mainnet')).toBe('mainnet')
    expect(midnightNetworkIdForNetwork('preprod')).toBe('preprod')
    expect(midnightNetworkIdForNetwork('preview')).toBe('preview')
  })

  it('encodes a preprod address with the HRP the preprod indexer accepts', () => {
    // The end-to-end statement of the bug above: an address encoded for our `preprod`
    // network must carry `mn_addr_preprod`, because that string is what the indexer
    // parses and what any other preprod wallet will produce for the same keys.
    const payload = new Uint8Array(32).fill(7)
    expect(encodeNightAddress(payload, midnightNetworkIdForNetwork('preprod'))).toMatch(/^mn_addr_preprod1/)
  })
})
