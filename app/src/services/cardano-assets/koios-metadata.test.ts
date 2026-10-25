import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {fetchKoiosTokenInfos} from './koios-metadata'
import type {FetchLike} from './token-metadata'

const KOIOS = 'https://koios.example/api/v1'
const POLICY = 'a'.repeat(56)
const NAME = '4d59544b4e' // "MYTKN"
const ID = `${POLICY}.${NAME}`
const run = <A>(e: Effect.Effect<A>) => Effect.runPromise(e)

const stub =
  (rows: unknown, ok = true, status = 200): FetchLike =>
  () =>
    Promise.resolve({ok, status, json: async () => rows})

describe('fetchKoiosTokenInfos', () => {
  it('resolves registry decimals/ticker/name for a registered asset', async () => {
    const impl = stub([
      {policy_id: POLICY, asset_name: NAME, token_registry_metadata: {name: 'My Token', ticker: 'MYT', decimals: 4}},
    ])
    const out = await run(fetchKoiosTokenInfos([ID], KOIOS, undefined, impl))
    expect(out.get(ID)).toMatchObject({decimals: 4, ticker: 'MYT', name: 'My Token', known: true, isNft: false})
  })

  it('reads name/ticker/decimals from the CIP-68 datum when the registry is empty', async () => {
    // The real /asset_info shape for a CIP-68 (333) token no registry lists. The
    // original code bailed on `token_registry_metadata: null` and threw this away,
    // in a response it had already paid for — so the app showed the label prefix
    // "0014df10" with 0 decimals, mis-scaling the quantity by 10x as well.
    const hex = (t: string) => [...new TextEncoder().encode(t)].map((b) => b.toString(16).padStart(2, '0')).join('')
    const CIP68_ID = `${POLICY}.0014df10434c4950204954`
    const impl = stub([
      {
        policy_id: POLICY,
        asset_name: '0014df10434c4950204954',
        asset_name_ascii: 'CLIP IT',
        token_registry_metadata: null,
        cip68_metadata: {
          '333': {
            fields: [
              {
                map: [
                  {k: {bytes: hex('name')}, v: {bytes: hex('FOR THE CLUTURE')}},
                  {k: {bytes: hex('decimals')}, v: {int: 1}},
                  {k: {bytes: hex('ticker')}, v: {bytes: hex('1CLIP')}},
                ],
              },
              {int: 1},
            ],
          },
        },
      },
    ])
    const out = await run(fetchKoiosTokenInfos([CIP68_ID], KOIOS, undefined, impl))
    expect(out.get(CIP68_ID)).toMatchObject({
      decimals: 1,
      ticker: '1CLIP',
      name: 'FOR THE CLUTURE',
      label: '1CLIP',
      known: true,
    })
  })

  it('prefers the curated registry over the datum when both are present', async () => {
    const hex = (t: string) => [...new TextEncoder().encode(t)].map((b) => b.toString(16).padStart(2, '0')).join('')
    const impl = stub([
      {
        policy_id: POLICY,
        asset_name: NAME,
        token_registry_metadata: {name: 'Registry Name', ticker: 'REG', decimals: 6},
        cip68_metadata: {'333': {fields: [{map: [{k: {bytes: hex('ticker')}, v: {bytes: hex('DATUM')}}]}]}},
      },
    ])
    const out = await run(fetchKoiosTokenInfos([ID], KOIOS, undefined, impl))
    expect(out.get(ID)).toMatchObject({ticker: 'REG', name: 'Registry Name', decimals: 6})
  })

  it('reassembles a chunked byte string (CIP-68 splits values over 64 bytes)', async () => {
    const hex = (t: string) => [...new TextEncoder().encode(t)].map((b) => b.toString(16).padStart(2, '0')).join('')
    const impl = stub([
      {
        policy_id: POLICY,
        asset_name: NAME,
        token_registry_metadata: null,
        cip68_metadata: {
          '222': {
            fields: [{map: [{k: {bytes: hex('name')}, v: {list: [{bytes: hex('Long ')}, {bytes: hex('Name')}]}}]}],
          },
        },
      },
    ])
    const out = await run(fetchKoiosTokenInfos([ID], KOIOS, undefined, impl))
    // A 222 asset is indivisible, so absent decimals means 0 rather than unknown.
    expect(out.get(ID)).toMatchObject({name: 'Long Name', decimals: 0})
  })

  it('still skips a row with neither registry nor usable datum', async () => {
    const impl = stub([{policy_id: POLICY, asset_name: NAME, token_registry_metadata: null, cip68_metadata: null}])
    const out = await run(fetchKoiosTokenInfos([ID], KOIOS, undefined, impl))
    expect(out.has(ID)).toBe(false)
  })

  it('skips assets with no token_registry_metadata and no datum (unregistered)', async () => {
    const impl = stub([{policy_id: POLICY, asset_name: NAME, token_registry_metadata: null}])
    const out = await run(fetchKoiosTokenInfos([ID], KOIOS, undefined, impl))
    expect(out.has(ID)).toBe(false)
  })

  it('reads CIP-25 media and name from the minting metadata, and marks it an NFT', async () => {
    // The pre-CIP-68 NFT standard, and still most Cardano NFTs. Real shape from
    // /asset_info for a Cardania founder card.
    const NFT_NAME_HEX = '43617264616e6961466f756e646572477265656e'
    const NFT_ID = `${POLICY}.${NFT_NAME_HEX}`
    const impl = stub([
      {
        policy_id: POLICY,
        asset_name: NFT_NAME_HEX,
        token_registry_metadata: null,
        cip68_metadata: null,
        total_supply: '1',
        minting_tx_metadata: {
          '721': {
            [POLICY]: {
              CardaniaFounderGreen: {
                name: "Cardania Founder's Card - Green",
                image: 'ipfs://QmchvzUf2dmCSuVaJWGVhDiXNJJENmtU8fzSDixw7HZ88m',
                mediaType: 'image/jpeg',
              },
            },
          },
        },
      },
    ])
    const out = await run(fetchKoiosTokenInfos([NFT_ID], KOIOS, undefined, impl))
    expect(out.get(NFT_ID)).toMatchObject({
      name: "Cardania Founder's Card - Green",
      image: 'ipfs://QmchvzUf2dmCSuVaJWGVhDiXNJJENmtU8fzSDixw7HZ88m',
      mediaType: 'image/jpeg',
      isNft: true,
      decimals: 0,
    })
  })

  it('does not call a fungible an NFT just because it carries 721 metadata', async () => {
    // CAST has 1.5 billion units AND CIP-25 metadata; a metadata-presence rule
    // flagged it as unique, which stripped its ticker from every amount.
    const impl = stub([
      {
        policy_id: POLICY,
        asset_name: NAME,
        total_supply: '1500000000',
        token_registry_metadata: null,
        minting_tx_metadata: {'721': {[POLICY]: {[NAME]: {name: 'Fungible', image: 'https://e.org/i.png'}}}},
      },
    ])
    const out = await run(fetchKoiosTokenInfos([ID], KOIOS, undefined, impl))
    expect(out.get(ID)).toMatchObject({name: 'Fungible', image: 'https://e.org/i.png', isNft: false})
  })

  it('does not call a 2500-copy collectible unique, but still carries its media', async () => {
    const impl = stub([
      {
        policy_id: POLICY,
        asset_name: NAME,
        total_supply: '2500',
        token_registry_metadata: null,
        minting_tx_metadata: {'721': {[POLICY]: {[NAME]: {name: 'Founder Card', image: 'ipfs://QmX'}}}},
      },
    ])
    const out = await run(fetchKoiosTokenInfos([ID], KOIOS, undefined, impl))
    expect(out.get(ID)).toMatchObject({name: 'Founder Card', image: 'ipfs://QmX', isNft: false})
  })

  it('finds a CIP-25 entry keyed by hex asset name, not only ASCII', async () => {
    const impl = stub([
      {
        policy_id: POLICY,
        asset_name: NAME,
        total_supply: '1',
        token_registry_metadata: null,
        minting_tx_metadata: {'721': {[POLICY]: {[NAME]: {name: 'Hex Keyed', image: 'https://e.org/i.png'}}}},
      },
    ])
    const out = await run(fetchKoiosTokenInfos([ID], KOIOS, undefined, impl))
    expect(out.get(ID)).toMatchObject({name: 'Hex Keyed', image: 'https://e.org/i.png', isNft: true})
  })

  it('reassembles a CIP-25 image URI split across array chunks', async () => {
    const impl = stub([
      {
        policy_id: POLICY,
        asset_name: NAME,
        token_registry_metadata: null,
        minting_tx_metadata: {
          '721': {[POLICY]: {[NAME]: {name: 'Chunked', image: ['ipfs://Qm', 'abc', 'def']}}},
        },
      },
    ])
    const out = await run(fetchKoiosTokenInfos([ID], KOIOS, undefined, impl))
    expect(out.get(ID)?.image).toBe('ipfs://Qmabcdef')
  })

  it('marks a CIP-68 222 asset as an NFT with its image', async () => {
    const hex = (t: string) => [...new TextEncoder().encode(t)].map((b) => b.toString(16).padStart(2, '0')).join('')
    const impl = stub([
      {
        policy_id: POLICY,
        asset_name: NAME,
        token_registry_metadata: null,
        cip68_metadata: {
          '222': {
            fields: [
              {
                map: [
                  {k: {bytes: hex('name')}, v: {bytes: hex('Lil Sappys #942')}},
                  {k: {bytes: hex('image')}, v: {bytes: hex('ipfs://QmWJXZ')}},
                  {k: {bytes: hex('mediaType')}, v: {bytes: hex('image/png')}},
                ],
              },
            ],
          },
        },
      },
    ])
    const out = await run(fetchKoiosTokenInfos([ID], KOIOS, undefined, impl))
    expect(out.get(ID)).toMatchObject({
      name: 'Lil Sappys #942',
      image: 'ipfs://QmWJXZ',
      mediaType: 'image/png',
      isNft: true,
      decimals: 0,
    })
  })

  it('does not mark a fungible CIP-68 333 asset as an NFT', async () => {
    const hex = (t: string) => [...new TextEncoder().encode(t)].map((b) => b.toString(16).padStart(2, '0')).join('')
    const impl = stub([
      {
        policy_id: POLICY,
        asset_name: NAME,
        token_registry_metadata: null,
        cip68_metadata: {'333': {fields: [{map: [{k: {bytes: hex('ticker')}, v: {bytes: hex('FT')}}]}]}},
      },
    ])
    const out = await run(fetchKoiosTokenInfos([ID], KOIOS, undefined, impl))
    expect(out.get(ID)?.isNft).toBe(false)
  })

  it('degrades to empty on a failed request (never throws)', async () => {
    const out = await run(fetchKoiosTokenInfos([ID], KOIOS, undefined, stub([], false, 500)))
    expect(out.size).toBe(0)
  })

  it('ignores malformed ids (wrong policy length)', async () => {
    let called = false
    const impl: FetchLike = () => {
      called = true
      return Promise.resolve({ok: true, status: 200, json: async () => []})
    }
    const out = await run(fetchKoiosTokenInfos(['deadbeef.00'], KOIOS, undefined, impl))
    expect(out.size).toBe(0)
    expect(called).toBe(false) // no request when there's nothing well-formed to ask
  })

  // ⚠️ Koios refuses a POST body over 5120 bytes — "Please ensure your request body size is below 5120
  // bytes". The old contract was a COUNT of 500 assets, which is about 40 KB, so every batch from a
  // wallet holding more than ~60 assets was refused and the tokens kept unknown decimals. The count was
  // asserted here and the size never was, which is exactly how it shipped.
  it('keeps every request body under Koios’s 5120-byte cap', async () => {
    const ids = Array.from({length: 1200}, (_, i) => `${POLICY}.${i.toString(16).padStart(6, '0')}`)
    const bodyBytes: number[] = []
    const counts: number[] = []
    const impl: FetchLike = (_url, init) => {
      const raw = (init?.body ?? '{}') as string
      bodyBytes.push(raw.length)
      counts.push((JSON.parse(raw) as {_asset_list: unknown[]})._asset_list.length)
      return Promise.resolve({ok: true, status: 200, json: async () => []})
    }
    await run(fetchKoiosTokenInfos(ids, KOIOS, undefined, impl))
    expect(bodyBytes.length).toBeGreaterThan(1)
    for (const bytes of bodyBytes) expect(bytes).toBeLessThan(5120)
    // Every asset is still asked for — bounding the body must not drop any.
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1200)
  })

  // The response, not just the request: `token_registry_metadata` carries a base64 logo that nothing
  // here reads (icons come from the cexplorer CDN), and on a real mainnet wallet it was 92% of the
  // payload. Asking for the three keys we do read flattens them into columns and cuts it 44×.
  it('asks Koios only for the fields it reads, so no logos are downloaded', async () => {
    let requested = ''
    const impl: FetchLike = (url) => {
      requested = String(url)
      return Promise.resolve({ok: true, status: 200, json: async () => []})
    }
    await run(fetchKoiosTokenInfos([`${POLICY}.00`], KOIOS, undefined, impl))
    expect(requested).toContain('select=')
    expect(requested).toContain('token_registry_metadata->decimals')
    expect(requested).not.toContain('logo')
  })

  it('sends the bearer token when provided', async () => {
    let auth: string | undefined
    const impl: FetchLike = (_url, init) => {
      auth = init?.headers?.authorization
      return Promise.resolve({ok: true, status: 200, json: async () => []})
    }
    await run(fetchKoiosTokenInfos([ID], KOIOS, 'tok123', impl))
    expect(auth).toBe('Bearer tok123')
  })
})
