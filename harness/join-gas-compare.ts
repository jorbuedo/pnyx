// Diagnostic: build the SAME `join` call as the native rail, via midnight-js, then prove and
// optionally submit it. The point is to compare against the native builder's declared gas and
// isolate a `Transcript(Execution(OutOfGas))` rejection — a class only a live node can catch, since
// a host prove-and-verify oracle has no opinion on the node's replay cost
// (`docs/on-device-proving.md`). Kept pointed at the same circuit the device rail builds: the
// **open** `join`, against the open circle `deploy-local` leaves behind.
//
// Usage: node --import tsx harness/join-gas-compare.ts <identitySkHex> <personaSkHex> [--submit]
//
// The identity secret matters now: `join` spends an identity nullifier, so re-running with the same
// one fails as "identity already joined" rather than telling you anything about gas.
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {balanceAndSubmitProven} from '@pnyx/chain-client/submit-proven'
import {assembleWallet, ensureDust, waitForSections} from '@pnyx/chain-client/wallet'
import {bytes32} from '@pnyx/contract-client/bytes'
import {type CirclePrivateState, createCircleWitnesses} from '@pnyx/contract-client/circle-witnesses'
import {LedgerParameters, ZswapChainState} from '@midnight-ntwrk/ledger-v8'
import {createUnprovenCallTxFromInitialStates} from '@midnight-ntwrk/midnight-js-contracts'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {NodeZkConfigProvider} from '@midnight-ntwrk/midnight-js-node-zk-config-provider'
import {CompiledContract} from '@midnight-ntwrk/midnight-js-protocol/compact-js'
import {createDefaultTestLogger, initializeMidnightProviders} from '@midnight-ntwrk/testkit-js'
import {NetworkId} from '@midnight-ntwrk/wallet-sdk'
import {Contract} from '../contract/managed/circle/contract/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const managedDir = path.resolve(here, '../contract/managed/circle')
const {circleAddress} = JSON.parse(fs.readFileSync(path.resolve(here, '../.local-deploy.json'), 'utf8')) as {
  circleAddress: string
}

const hex32 = (value: string): Uint8Array => Uint8Array.from(value.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16))
const identitySk = hex32(process.argv[2] ?? '41'.repeat(32))
const personaSk = hex32(process.argv[3] ?? '42'.repeat(32))
const submit = process.argv.includes('--submit')

const env = {
  walletNetworkId: NetworkId.NetworkId.Undeployed,
  networkId: 'undeployed',
  indexer: 'http://127.0.0.1:8088/api/v4/graphql',
  indexerWS: 'ws://127.0.0.1:8088/api/v4/graphql/ws',
  node: 'http://127.0.0.1:9944',
  nodeWS: 'ws://127.0.0.1:9944',
  proofServer: 'http://127.0.0.1:6300',
}
setNetworkId(env.networkId)

const privateState: CirclePrivateState = {
  identitySk,
  personaSk,
  // Unused on the open path — `join` hashes it and asserts on neither result when `isOpen`.
  inviteSecret: bytes32(0),
}

const logger = createDefaultTestLogger()
const wallet = await assembleWallet(logger, env, '0000000000000000000000000000000000000000000000000000000000000001')
await wallet.wallet.start(wallet.zswapSecretKeys, wallet.dustSecretKey)
await waitForSections(wallet, 5 * 60_000, () => {})
await ensureDust(wallet as never, () => {})

const compiledContract = CompiledContract.make('PnyxCircle', Contract).pipe(
  CompiledContract.withWitnesses(createCircleWitnesses()),
  CompiledContract.withCompiledFileAssets(managedDir),
)
const providers = initializeMidnightProviders(wallet, env, {
  zkConfigPath: managedDir,
  privateStateStoreName: 'pnyx-join-gas-compare',
})
const liveState = await providers.publicDataProvider.queryContractState(circleAddress)
if (!liveState) throw new Error('circle state unavailable')

const unsubmitted = await createUnprovenCallTxFromInitialStates(
  new NodeZkConfigProvider<string>(managedDir),
  {
    compiledContract,
    circuitId: 'join',
    contractAddress: circleAddress,
    args: [],
    coinPublicKey: providers.walletProvider.getCoinPublicKey(),
    initialContractState: liveState,
    initialZswapChainState: new ZswapChainState(),
    ledgerParameters: LedgerParameters.initialParameters(),
    initialPrivateState: privateState,
  } as never,
  providers.walletProvider.getEncryptionPublicKey(),
)
const unprovenTx = (unsubmitted as {private: {unprovenTx: unknown}}).private.unprovenTx

const proven = await providers.proofProvider.proveTx(unprovenTx as never)
const txBytes: Uint8Array = (proven as {serialize(): Uint8Array}).serialize()
const outFile = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length)
if (outFile) {
  fs.writeFileSync(outFile, txBytes)
  console.log(`proven: ${txBytes.length} bytes -> ${outFile}`)
}
if (submit) {
  console.log(`proven: ${txBytes.length} bytes; submitting…`)
  const result = await balanceAndSubmitProven(providers as never, txBytes)
  console.log(`landed: txId=${result.txId} blockHeight=${result.blockHeight}`)
}
await wallet.stop()
process.exit(0)
