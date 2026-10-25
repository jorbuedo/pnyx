// Read a deployed circle's on-chain membership and moderator set.
//
// The answer to "is this circle's moderation authority what we think it is", which nothing else can
// give you: the content plane records a `founderLeaf`, but only the contract says which auth key that
// leaf actually holds, and only the chain says whether `addModerator` landed.
//
// Run:
//   node --import tsx harness/read-circle-modauth.mts <contract-address-hex> [network] [leaf-hex]
//
// Pass a leaf (the content plane's `founderLeaf`) to ask whether that persona is a member and a
// moderator — which is how you check that the constructor seated the founder rather than trusting
// that it did.
//
// Read-only — no wallet, no DUST, no proof server. The address comes from the sponsor's
// `device-proven circle(<id>) on-chain (<txId>)` line via the indexer's `transactions(offset:
// {identifier})`, or from the deploy that derived it.
//
// ⚠️ Circles live on the **identity** axis, which is the network the content service declares
// (`GET /auth/config`), not whichever network the app's funds selector is showing.
import {indexerPublicDataProvider} from '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {NetworkId} from '@midnight-ntwrk/wallet-sdk'
import {ledger} from '../contract/managed/circle/contract/index.js'

const NETWORKS = {
  preprod: {
    id: NetworkId.NetworkId.PreProd,
    indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWS: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
  },
  preview: {
    id: NetworkId.NetworkId.Preview,
    indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
    indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
  },
} as const

const address = process.argv[2]
if (address === undefined) throw new Error('usage: read-circle-modauth.mts <contract-address-hex> [network]')
const networkName = (process.argv[3] ?? 'preprod') as keyof typeof NETWORKS
const network = NETWORKS[networkName]
if (network === undefined) throw new Error(`unknown network ${networkName}; expected ${Object.keys(NETWORKS).join(' or ')}`)

setNetworkId(network.id as never)
const reader = indexerPublicDataProvider(network.indexer, network.indexerWS)
const state = await reader.queryContractState(address)
if (!state) throw new Error(`no contract state at ${address} on ${networkName}`)

const l = ledger((state as unknown as {data: Parameters<typeof ledger>[0]}).data)
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
console.log(`\n=== circle ${address} on ${networkName} ===`)
console.log(`circleId : ${hex(l.circleId)}`)
console.log(`isOpen   : ${l.isOpen}`)
console.log('\nmoderatorAuth (persona leaf -> request-signing pubkey):')
let count = 0
for (const [leaf, authPub] of l.moderatorAuth) {
  count += 1
  console.log(`  ${hex(leaf)}\n    -> ${hex(authPub)}`)
}
console.log(`\nentries: ${count}`)

const leafHex = process.argv[4]
if (leafHex !== undefined) {
  const leaf = Uint8Array.from(Buffer.from(leafHex, 'hex'))
  console.log(`\nleaf ${leafHex}`)
  console.log(`  in members    : ${l.members.findPathForLeaf(leaf) !== undefined}`)
  console.log(`  in moderators : ${l.moderators.findPathForLeaf(leaf) !== undefined}`)
  console.log(`  has auth key  : ${l.moderatorAuth.member(leaf)}`)
}
console.log(`joinedIdentities entries: ${[...l.joinedIdentities].length}`)
