/**
 * The walk against the REAL provider, which is the seam every fake in `history.test.ts` hides.
 *
 * `getTxsAt` refuses an `offset` whenever the address batch needs more than one request, so the
 * batch size is not ours to choose: the provider publishes it as `splitAddressesForTxsAt`. When
 * this file was written the walk held its own count instead — 40, sized against Koios's
 * 5120-byte body limit rather than the client's own 4096-byte budget — and a mainnet wallet with
 * 44 discovered addresses had every window of every refresh refused in about 7 ms, with no
 * request issued and the stored list left standing. Nothing failed loudly; the list simply never
 * gained the transaction the user could see on an explorer.
 *
 * So what is asserted here is that the walk *asks*: with the real Koios client behind it, a
 * wallet of that shape pages its history and stores what came back.
 */
import {Address as EvolutionAddress, KoiosProvider} from '@evolution-sdk/evolution'
import {Effect} from 'effect'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {cardanoDataRef, clearCardanoDataStore, setCardanoDataStore} from './cardano-store'
import {syncCardanoHistory} from './history'
import type {CardanoRail} from './rail'

/** The reported wallet's shape: a full external gap scan plus change, all with a stake part. */
const ADDRESS_COUNT = 44

const addressAt = (i: number): string =>
  EvolutionAddress.toBech32(
    EvolutionAddress.fromHex(`01${(i + 1).toString(16).padStart(2, '0').repeat(28)}${'cd'.repeat(28)}`),
  )

const TX = `${'ab'.repeat(31)}cd`

/** One reference, then nothing — enough to prove a request was served and a row stored. */
const txRefRow = {
  tx_hash: TX,
  epoch_no: 1,
  block_height: 900,
  block_time: 1_700_000_000,
}

const txInfoRow = {
  tx_hash: TX,
  block_height: 900,
  block_time: 1_700_000_000,
  fee: '1000',
  inputs: [],
  outputs: [],
  certificates: [],
  withdrawals: [],
  assets_minted: [],
}

const harness = () => {
  const paths: string[] = []
  const saved: string[] = []
  const store = {
    listTxRows: () => Effect.succeed([]),
    saveTxRows: (rows: readonly {readonly hash: string}[]) =>
      Effect.sync(() => {
        saved.push(...rows.map((r) => r.hash))
      }),
    loadTxCheckpoint: () => Effect.succeed(null),
    saveTxCheckpoint: () => Effect.void,
  }
  setCardanoDataStore(store as never)

  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = new URL(String(input))
    paths.push(url.pathname)
    const body = url.pathname.endsWith('/address_txs')
      ? [txRefRow]
      : url.pathname.endsWith('/tx_info')
        ? [txInfoRow]
        : url.pathname.endsWith('/tip')
          ? [{abs_slot: 1, block_no: 1_000, epoch_no: 1, block_time: 1_700_000_000}]
          : []
    return new Response(JSON.stringify(body), {status: 200, headers: {'Content-Type': 'application/json'}})
  })

  const koios = new KoiosProvider.Koios('https://api.koios.rest/api/v1')
  const rail = {
    dataRef: cardanoDataRef('group-1', 'cardano:mainnet', 0),
    knownAddresses: Array.from({length: ADDRESS_COUNT}, (_, i) => addressAt(i)),
    rewardAddressBech32: null,
    config: {networkId: 1, network: 'mainnet'},
    chain: koios.effect,
  } as unknown as CardanoRail

  return {rail, paths, saved}
}

describe('the history walk over the real provider', () => {
  beforeEach(() => clearCardanoDataStore())
  afterEach(() => {
    clearCardanoDataStore()
    vi.unstubAllGlobals()
  })

  it('pages a wallet whose address list needs more than one request, and stores what came back', async () => {
    const {rail, paths, saved} = harness()

    const outcome = await Effect.runPromise(syncCardanoHistory(rail))

    // The refusal spent no request, so the giveaway was an EMPTY request log beside a failing walk.
    expect(paths.filter((p) => p.endsWith('/address_txs')).length).toBeGreaterThan(0)
    expect(saved).toContain(TX)
    expect(outcome.storedNew).toBeGreaterThan(0)
  })

  it('splits that list the way the provider says it must, not the way we would guess', () => {
    const koios = new KoiosProvider.Koios('https://api.koios.rest/api/v1')
    const addresses = Array.from({length: ADDRESS_COUNT}, (_, i) => EvolutionAddress.fromBech32(addressAt(i)))

    const batches = koios.effect.splitAddressesForTxsAt?.(addresses)

    // More than one, for this count at this address length — which is exactly what a hand-held
    // count of 40 got wrong, and what the walk now never decides for itself.
    expect(batches?.length).toBeGreaterThan(1)
    expect(batches?.flat()).toHaveLength(ADDRESS_COUNT)
  })
})
