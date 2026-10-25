/**
 * What the pinned ledger's `Transaction.merge` actually does — the check a Midnight co-funding
 * builder rests on.
 *
 * ⚠️ **Asserted against the real wasm, because the question is whether it is implemented at all.**
 * This ledger declares methods it always refuses (`balanceSealedTransaction` is one), so "the type
 * says merge exists" was not evidence. It is implemented: the call reaches ledger code and fails with
 * a ledger error about our inputs rather than a "not supported".
 *
 * ⚠️ **And it fails on the SEGMENT ID, not on the coins.** The declaration says merge throws "if both
 * transactions have contract interactions, or they spend the same coins"; what it actually says first
 * is `key (segment_id) collision during intents merge: 1`. That is the constraint a co-funding design
 * has to answer, and it is answerable — `SegmentSpecifier` documents `{tag: 'random'}` as "ideal for
 * merging with other intents" and `Transaction.fromPartsRandomized` exists to produce one. Our own
 * device rail hardcodes `CALL_SEGMENT = 1` (`packages/midnight-native/rust/src/tx.rs`), which is why
 * two transactions we build collide.
 */
import {Transaction} from '@midnight-ntwrk/ledger-v8'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {describe, expect, it} from 'vitest'
import {PROVEN_TX_MARKERS} from './proven'

// The same real preprod transfer `sponsorship.test.ts` reads, built by
// `harness/unshielded-send-preprod.ts`.
const REAL_TRANSFER_B64 =
  'bWlkbmlnaHQ6dHJhbnNhY3Rpb25bdjldKHNpZ25hdHVyZVt2MV0scHJvb2YsZW1iZWRkZWQtZnJbdjFdKTpEAAgBAACVASJfoBLH' +
  'an8rl1055tivDihbaAUmADHv7O0S8X98cBW7E6YInAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA78dclLxws8TZ1oin' +
  'TRANsxRB9Oheif0x0lz5QSWyFiEABAQIAQQAEQECCT0AQesKW9gwnUSwwI3Qaq5Thk85hPCjsLyFXqY6sUOT7c4AAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARASJWYxJrmKGvr+qhYlxs5brlAKNUAaJisry1EafdSYNhjZpEaAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAABBAIAQQEFBQDBAEEEAgMGAgECAABATj/1depTj0h563slTJkhfqgN1dM5vjVTdp3K2vijJkNlKN2' +
  'u4/MhJtSkMv+M+Lnek0njyNUXRepIHUyQHCvmiUEIAgBBAwIHCQAAAQACCgspAEAAQNM24Zqc9m69L+TDBH9UMkvwK2IRUt5u8uA' +
  'zuuX8CSYedtvL8EGCAAwAAQ0CAEEBDiQAwRAgEfcVAyUzrcEojh1wRJz4WuwuKh67YTekR8hM1aBFfJUCDwsrAAccHJlcHJvZAFz' +
  '2br0v5MMEf1QyS/ArYhFS3m7y4DO65fwJJh5228vwQY='

const deserialize = () => {
  const [markerS, markerP, markerB] = PROVEN_TX_MARKERS
  return Transaction.deserialize(markerS, markerP, markerB, Buffer.from(REAL_TRANSFER_B64, 'base64'))
}

describe('Transaction.merge on the pinned ledger', () => {
  it('is implemented, not a declared-and-refusing method', () => {
    setNetworkId('preprod')
    const tx = deserialize()
    expect(typeof (tx as unknown as {merge?: unknown}).merge).toBe('function')
  })

  it('refuses two transactions that share a segment id, naming the segment', () => {
    // ⚠️ This is the whole finding. Both are ours, both sit at segment 1, so they cannot merge — and
    // the message is about the segment, not the coins they happen to share. A co-funding flow has to
    // give each contributor its own segment.
    setNetworkId('preprod')
    expect(() => deserialize().merge(deserialize())).toThrow(/segment_id/)
  })

  it('carries exactly one identifier, and it is not a hash to agree on beforehand', () => {
    // `transactionHash()` documents that merging makes it unusable for watching, and a device-built
    // transaction has no hash until the sponsor binds it — so a co-funding session needs an
    // app-assigned id, the way the Cardano half uses `pendingId`.
    setNetworkId('preprod')
    expect(deserialize().identifiers()).toHaveLength(1)
  })
})
