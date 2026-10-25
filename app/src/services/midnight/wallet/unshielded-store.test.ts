import {describe, expect, it} from 'vitest'

import {parseUnshieldedCache, serializeUnshieldedCache, type UnshieldedCache} from './unshielded-store'
import type {UnshieldedUtxo} from './unshielded-utxo-set'

const ADDRESS = 'mn_addr_preprod1ours'

const utxo = (over: Partial<UnshieldedUtxo> = {}): UnshieldedUtxo => ({
  owner: ADDRESS,
  tokenType: '0100000000000000000000000000000000000000000000000000000000000000',
  value: 1_000_000n,
  intentHash: 'aa11',
  outputIndex: 0,
  ctime: 1_700_000_000,
  registeredForDustGeneration: false,
  ...over,
})

const cache = (over: Partial<UnshieldedCache> = {}): UnshieldedCache => ({
  utxos: new Map([['aa11:0', utxo()]]),
  activity: [],
  transactionId: 42,
  address: ADDRESS,
  ...over,
})

describe('unshielded cache round trip', () => {
  it('survives serialize → parse unchanged', () => {
    const parsed = parseUnshieldedCache(serializeUnshieldedCache(cache()))
    expect(parsed?.address).toBe(ADDRESS)
    expect(parsed?.transactionId).toBe(42)
    expect([...(parsed?.utxos.values() ?? [])]).toEqual([utxo()])
  })

  it('keeps atomic units a Number would round', () => {
    const big = 9_007_199_254_740_993n
    const parsed = parseUnshieldedCache(
      serializeUnshieldedCache(cache({utxos: new Map([['aa11:0', utxo({value: big})]])})),
    )
    expect([...(parsed?.utxos.values() ?? [])][0]?.value).toBe(big)
  })

  it('rekeys from the UTxO itself, so a tampered key cannot shadow a real one', () => {
    const raw = serializeUnshieldedCache(cache())
    const parsed = parseUnshieldedCache(raw)
    expect([...(parsed?.utxos.keys() ?? [])]).toEqual(['aa11:0'])
  })
})

describe('parseUnshieldedCache', () => {
  it('reads an absent value as no cache', () => {
    expect(parseUnshieldedCache(null)).toBeUndefined()
    expect(parseUnshieldedCache('')).toBeUndefined()
  })

  it('reads unparseable JSON as no cache rather than throwing', () => {
    expect(parseUnshieldedCache('{not json')).toBeUndefined()
  })

  it('drops an activity row with no output counts rather than reading absence as zero', () => {
    // A row from before the field would otherwise report "spent 0 of your outputs" — a claim about the
    // transaction. This is the shape a v5 blob had, under the pre-rename keys.
    const raw = JSON.stringify({
      version: 8,
      address: ADDRESS,
      transactionId: 1,
      utxos: [],
      activity: [{transactionId: 1, hash: 'aa', direction: 'sent', net: [], tokens: [], counterparties: []}],
    })
    expect(parseUnshieldedCache(raw)?.activity).toEqual([])
  })

  it('discards a version-6 blob, whose activity rows carry no identifiers', () => {
    // Identifiers cannot be recomputed from a stored row — they live in the transaction, which the
    // cache does not keep — so a v6 row could never be matched to a send that produced it.
    const v6 = JSON.stringify({version: 6, address: ADDRESS, transactionId: 500, utxos: [], activity: []})

    expect(parseUnshieldedCache(v6)).toBeUndefined()
  })

  it('discards a version-4 blob, whose activity rows carry no input/output counts', () => {
    // A v4 row would read as `0 spent`, which is a claim about the transaction rather than an absence.
    const v4 = JSON.stringify({version: 4, address: ADDRESS, transactionId: 500, utxos: [], activity: []})
    expect(parseUnshieldedCache(v4)).toBeUndefined()
  })

  it('discards a version-3 blob, whose activity rows say nothing about which tokens moved', () => {
    // v3 stored only the signed net, and a self-send's net cancels to empty — so its rows cannot say
    // whether they moved NIGHT or nothing at all. Replaying is the only way to recover that.
    const v3 = JSON.stringify({version: 3, address: ADDRESS, transactionId: 500, utxos: [], activity: []})
    expect(parseUnshieldedCache(v3)).toBeUndefined()
  })

  it('discards a version-2 blob, whose UTxOs carry no creating-transaction hash', () => {
    // Upgrading would leave outputs with no link to the transaction that created them, on a screen that
    // now offers one.
    const v2 = JSON.stringify({version: 2, address: ADDRESS, transactionId: 500, utxos: [], activity: []})
    expect(parseUnshieldedCache(v2)).toBeUndefined()
  })

  it('discards a version-1 blob rather than upgrading it', () => {
    // v1 held a UTxO set and a cursor but no activity. "Upgrading" it would produce a wallet whose history
    // starts at the cursor and looks complete; discarding replays from zero, which is cheap and correct.
    const v1 = JSON.stringify({version: 1, address: ADDRESS, transactionId: 500, utxos: []})
    expect(parseUnshieldedCache(v1)).toBeUndefined()
  })

  it('refuses a blob from an unknown version', () => {
    // A version *above* the current one as well as below: a blob written by a newer build is no more
    // readable than an older one, and reading it would be guessing at a shape nobody has described.
    expect(
      parseUnshieldedCache(JSON.stringify({version: 9, address: ADDRESS, transactionId: 0, utxos: []})),
    ).toBeUndefined()
    expect(
      parseUnshieldedCache(JSON.stringify({version: 7, address: ADDRESS, transactionId: 0, utxos: []})),
    ).toBeUndefined()
  })

  it('refuses a blob with no address, since a set only means anything for one', () => {
    expect(parseUnshieldedCache(JSON.stringify({version: 1, transactionId: 0, utxos: []}))).toBeUndefined()
  })

  it('drops a row whose value is not digits instead of reading it as zero', () => {
    const raw = JSON.stringify({
      version: 8,
      address: ADDRESS,
      transactionId: 1,
      utxos: [
        {owner: ADDRESS, tokenType: 'aa', value: '5', intentHash: 'bb', outputIndex: 0, ctime: null},
        {owner: ADDRESS, tokenType: 'aa', value: '1e6', intentHash: 'cc', outputIndex: 0, ctime: null},
      ],
    })
    const parsed = parseUnshieldedCache(raw)
    expect(parsed?.utxos.size).toBe(1)
    expect([...(parsed?.utxos.values() ?? [])][0]?.value).toBe(5n)
  })

  it('defaults a missing cursor to a full replay rather than to a guess', () => {
    const raw = JSON.stringify({version: 8, address: ADDRESS, utxos: []})
    expect(parseUnshieldedCache(raw)?.transactionId).toBe(0)
  })

  it('reads an empty set as an empty set, not as absent', () => {
    const parsed = parseUnshieldedCache(JSON.stringify({version: 8, address: ADDRESS, transactionId: 9, utxos: []}))
    expect(parsed).toBeDefined()
    expect(parsed?.utxos.size).toBe(0)
    expect(parsed?.transactionId).toBe(9)
  })
})
