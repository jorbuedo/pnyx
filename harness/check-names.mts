// What does one identity's row actually hold? Answers "did that write land" without trusting the
// app's own view of it.
//
// ⚠️ One contract per identity (`docs/BOUNDED_STATE_ARCHITECTURE.md` §1) — there is no shared
// `names` / `identities` registry to enumerate any more, so this takes the address of the row to
// read. The app logs it as `identity shell deploy relayed`.
import {indexerPublicDataProvider} from '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {ledger} from '../contract/managed/identity/contract/index.js'

setNetworkId('preprod')
const ADDR = process.argv[2]
if (ADDR === undefined) throw new Error('usage: check-names.mts <identity contract address>')
// ⚠️ Both public Midnight indexers answer 410 (2026-10-13). Preprod's replacement authenticates by
// `?project_id=` in the query string, so the URL is a credential and cannot be written here.
const HTTP = process.env.MIDNIGHT_INDEXER_PREPROD
if (HTTP === undefined) throw new Error('set MIDNIGHT_INDEXER_PREPROD (and _WS for the socket)')
const WS = process.env.MIDNIGHT_INDEXER_PREPROD_WS ?? HTTP.replace(/^http/, 'ws').replace('/graphql', '/graphql/ws')

const reader = indexerPublicDataProvider(HTTP, WS)
const state = await reader.queryContractState(ADDR)
if (!state) throw new Error('no contract state on the indexer')
const l = ledger(state.data) as unknown as {
  anchor: Uint8Array
  authPub: Uint8Array
  primaryName: Uint8Array
  card: Iterable<[number, unknown]>
}

const dec = new TextDecoder()
const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex')
const isZero = (b: Uint8Array) => b.every((x) => x === 0)
// `primaryName` is a fixed Bytes<32> zero-padded by the circuit, so an unset one is all zeros --
// a different fact from an empty string, and reported as such.
const nameOf = (b: Uint8Array) => (isZero(b) ? '(unset)' : `'${dec.decode(b).replace(/\0+$/, '')}'`)

console.log(`identity ${ADDR}`)
console.log(`  anchor      ${isZero(l.anchor) ? '(unset)' : hexOf(l.anchor)}`)
console.log(`  authPub     ${isZero(l.authPub) ? '(unset)' : hexOf(l.authPub)}`)
console.log(`  primaryName ${nameOf(l.primaryName)}`)
console.log(`  card        ${[...l.card].length} row(s)`)
process.exit(0)
