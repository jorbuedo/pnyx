import {describe, expect, it} from 'vitest'
import {projectDreps, projectPools} from './worker'

describe('projectDreps', () => {
  it('keeps only the fields drep.ts reads and drops the rest', () => {
    const raw = [
      {
        id: 'ab12',
        from: 'key',
        metadataVerification: 'verified',
        stake: '1234',
        delegatorCount: 9,
        anchorUrl: 'https://anchor',
        anchorHash: 'aa',
        // bloat the app never reads:
        mandateEpoch: 500,
        deposit: '500000000',
        registeredDate: '2025-01-01',
        metadataHash: 'deadbeef',
        metadata: {
          givenName: {'@value': 'Alice'},
          image: {contentUrl: 'https://img/alice', sha256: 'zzz'},
          objectives: {'@value': 'lots of text'},
          motivations: {'@value': 'more text'},
          references: [{'@type': 'Link', label: 'x', uri: 'https://x'}],
        },
      },
    ]
    const out = projectDreps(raw) as Record<string, unknown>[]
    expect(out).toEqual([
      {
        id: 'ab12',
        from: 'key',
        metadataVerification: 'verified',
        metadata: {givenName: {'@value': 'Alice'}, image: {contentUrl: 'https://img/alice'}},
        stake: '1234',
        delegatorCount: 9,
        anchorUrl: 'https://anchor',
        anchorHash: 'aa',
      },
    ])
  })

  it('drops the image (and verification) when not verified, keeps givenName', () => {
    const out = projectDreps([
      {id: 'x', from: 'key', metadataVerification: 'unverified', metadata: {givenName: 'Bob', image: {contentUrl: 'u'}}},
    ]) as Record<string, unknown>[]
    expect(out[0]).toEqual({id: 'x', from: 'key', metadata: {givenName: 'Bob'}})
  })

  it('returns [] for a non-array input', () => {
    expect(projectDreps({not: 'an array'})).toEqual([])
  })
})

describe('projectPools', () => {
  it('keeps only the fields pool.ts reads, preserving the {data:{data}} shape', () => {
    const raw = {
      code: 200,
      data: {
        data: [
          {
            pool_id: 'pool1abc',
            pool_id_hash_raw: 'deadbeef',
            pool_name: {
              ticker: 'ABC',
              name: 'Alpha',
              description: 'd',
              homepage: 'https://a',
              extended: {twitter_handle: '@a', github_handle: 'gh'}, // dropped
            },
            pool_update: {
              active: {margin: 0.02, fixed_cost: '340000000', pledge: '1000', extra: 'x'},
              live: {margin: 0.05, fixed_cost: '340000000', pledge: '1000'},
            },
            pool_retire: {active: {retiring_epoch: null}},
            saturation: 0.7,
            delegators: 42,
            live_stake: '5000000',
            active_stake: '4000000', // dropped
            blocks: {epoch: 3, total: 900}, // dropped
            stats: {recent: {roa: 3.2, extra: 1}, lifetime: {roa: 2.8}},
            // the bloat: full per-epoch history — only "0".data.block.minted survives
            epochs: {
              '0': {no: 500, data: {block: {minted: 12, estimated: 14}, stake: {live: '1'}}},
              '1': {no: 499, data: {block: {minted: 20}}},
              '2': {no: 498, data: {block: {minted: 18}}},
            },
          },
        ],
      },
    }
    const out = projectPools(raw) as {data: {data: Record<string, unknown>[]}}
    expect(out).toEqual({
      data: {
        data: [
          {
            pool_id: 'pool1abc',
            pool_id_hash_raw: 'deadbeef',
            pool_name: {ticker: 'ABC', name: 'Alpha', description: 'd', homepage: 'https://a'},
            pool_update: {
              active: {margin: 0.02, fixed_cost: '340000000', pledge: '1000'},
              live: {margin: 0.05, fixed_cost: '340000000', pledge: '1000'},
            },
            pool_retire: {active: {retiring_epoch: null}},
            saturation: 0.7,
            delegators: 42,
            stats: {recent: {roa: 3.2}, lifetime: {roa: 2.8}},
            epochs: {'0': {data: {block: {minted: 12}}}},
            live_stake: '5000000',
          },
        ],
      },
    })
  })

  it('omits absent optional groups rather than emitting empty objects', () => {
    const raw = {data: {data: [{pool_id: 'pool1x', pool_id_hash_raw: 'ff'}]}}
    const out = projectPools(raw) as {data: {data: Record<string, unknown>[]}}
    expect(out.data.data[0]).toEqual({pool_id: 'pool1x', pool_id_hash_raw: 'ff'})
  })

  it('returns an empty list for a malformed envelope', () => {
    expect(projectPools({nope: true})).toEqual({data: {data: []}})
  })
})
