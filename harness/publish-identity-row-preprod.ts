// Publish one identity row to the deployed preprod contract, then capture the resulting state.
//
// Two jobs, both prerequisites for taking identity-row reads off the content service:
//  1. Prove the freshly deployed preprod contract actually accepts `publishIdentityRow` — a deploy
//     succeeding says nothing about a witness-bearing circuit landing against it.
//  2. Produce a fixture containing a REAL row, so the native Rust decoder can be tested against
//     bytes a chain produced rather than bytes a test invented. No published row existed on any
//     chain before this: the old preprod contract predates the circuit and the new one deployed
//     empty, which is exactly the gap that would have made a mocked decode test meaningless.
//
// Uses the service-side `callTx` path (host proving, this wallet pays) rather than the device's
// proven-relay path. Different producer, identical on-chain encoding — which is all the decoder
// cares about.
//
// Run: bun run preprod:publish-row
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {assembleWallet, ensureDust, saveDustState, waitForSections} from '@pnyx/chain-client/wallet'
import {readPreprodWallet} from './preprod-wallet.js'
import {identityCommitment} from '@pnyx/contract-client/derivations'
import {bytes32} from '@pnyx/contract-client/bytes'
import {type IdentityPrivateState, createIdentityWitnesses} from '@pnyx/contract-client/identity-witnesses'
import {findDeployedContract} from '@midnight-ntwrk/midnight-js-contracts'
import {indexerPublicDataProvider} from '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {CompiledContract} from '@midnight-ntwrk/midnight-js-protocol/compact-js'
import {createDefaultTestLogger, initializeMidnightProviders} from '@midnight-ntwrk/testkit-js'
import {NetworkId} from '@midnight-ntwrk/wallet-sdk'
import {Contract, ledger} from '../contract/managed/identity/contract/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const managedDir = path.resolve(here, '../contract/managed/identity')
const deployFile = path.resolve(here, '../.preprod-deploy.json')
const fixtureDir = path.resolve(here, '../packages/midnight-native/rust/fixtures')

const env = {
  walletNetworkId: NetworkId.NetworkId.PreProd,
  networkId: 'preprod',
  indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
  indexerWS: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
  node: 'https://rpc.preprod.midnight.network',
  nodeWS: 'wss://rpc.preprod.midnight.network',
  proofServer: process.env.PROOF_SERVER_URL ?? 'http://127.0.0.1:6300',
}

setNetworkId(env.networkId)

const {contractAddress, network} = JSON.parse(fs.readFileSync(deployFile, 'utf8')) as {
  contractAddress: string
  network: string
}
if (network !== 'preprod') {
  throw new Error(`${deployFile} records network ${network}, not preprod`)
}
const {masterSeed: seed, dustStateFile, source} = await readPreprodWallet()
console.log(`wallet: ${source}`)

// Fixed so the fixture is reproducible and the expected `C` is derivable in the Rust test.
const privateState: IdentityPrivateState = {identitySk: bytes32(0x2a)}
const row = {anchor: bytes32(0x70), authPub: bytes32(0x71)}

const logger = createDefaultTestLogger()
const wallet = await assembleWallet(logger, env, seed, {dustStateFile})
await wallet.wallet.start(wallet.zswapSecretKeys, wallet.dustSecretKey)
await waitForSections(wallet, 45 * 60_000, (s) => {
  const d = s.dust.state.progress
  console.log(`sync: unshielded=${s.unshielded.progress?.isStrictlyComplete() === true} dust=${d.appliedIndex}/${d.highestRelevantWalletIndex}`)
})
await saveDustState(wallet as never, dustStateFile)
await ensureDust(wallet as never, console.log)

const compiledContract = CompiledContract.make('PnyxIdentity', Contract).pipe(
  CompiledContract.withWitnesses(createIdentityWitnesses()),
  CompiledContract.withCompiledFileAssets(managedDir),
)
const providers = initializeMidnightProviders(wallet, env, {
  zkConfigPath: managedDir,
  privateStateStoreName: 'pnyx-preprod-private-state',
})

console.log(`\nBinding to ${contractAddress}…`)
const deployed = await findDeployedContract(
  providers as never,
  {compiledContract, contractAddress, privateStateId: 'pnyxPreprod', initialPrivateState: privateState} as never,
)

type CallTx = Readonly<{publishIdentityRow: (anchor: unknown, authPub: unknown) => Promise<unknown>}>
const callTx = (deployed as unknown as {callTx: CallTx}).callTx

console.log('Publishing identity row (real proof, real block)…')
const t0 = performance.now()
await callTx.publishIdentityRow(row.anchor, row.authPub)
console.log(`published in ${(performance.now() - t0).toFixed(0)} ms`)

// Read the state back through the indexer — the same source the app will read directly.
const reader = indexerPublicDataProvider(env.indexer, env.indexerWS)
const state = await reader.queryContractState(contractAddress)
if (!state) {
  throw new Error('no contract state after publishing')
}
const view = ledger((state as unknown as {data: Parameters<typeof ledger>[0]}).data)
const expectedC = identityCommitment(privateState.identitySk)
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

// The client-derived `C` must be the id the contract was sealed with, or this is somebody else's
// identity contract and every write to it would fail `requireOwner`.
if (hex(view.id) !== hex(expectedC)) {
  throw new Error(`contract is sealed to ${hex(view.id)}, not the client-derived C ${hex(expectedC)} — derivation drift`)
}
console.log(
  [
    '',
    '=== Row on chain ===',
    `C:        ${hex(expectedC)}`,
    `anchor:   ${hex(view.anchor)}`,
    `authPub:  ${hex(view.authPub)}`,
    `name:     ${hex(view.primaryName)}`,
    `card rows: ${view.card.size()}`,
  ].join('\n'),
)

const serialized = (state as {serialize(): Uint8Array}).serialize()
const fixture = path.join(fixtureDir, 'identity_row_preprod.contract_state')
fs.writeFileSync(fixture, serialized)
fs.writeFileSync(
  path.join(fixtureDir, 'identity_row_preprod.inputs.json'),
  `${JSON.stringify({network: 'preprod', contractAddress, identitySk: hex(privateState.identitySk), c: hex(expectedC), row: {anchor: hex(row.anchor), authPub: hex(row.authPub)}}, null, 2)}\n`,
)
console.log(`\nFixture → ${fixture} (${serialized.length} bytes)`)

await wallet.stop()
