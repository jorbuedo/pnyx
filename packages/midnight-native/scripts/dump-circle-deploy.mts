// Writes the fixtures the native circle-deploy builder is verified against, and prints the
// constructor-produced state's structure so the Rust side can mirror it.
//
// Creating a circle is a DEPLOY, not a call (docs/CONTRACT_TOPOLOGY.md split 2), and the device
// builds it so the address commits to `(circleId, isOpen, founder, founderAuth, founderJoined)` — see
// docs/CONTRACT_MIGRATION.md "Decided 2026-08-11". The Rust builder therefore has to reproduce
// `contract.initialState(...)` exactly: the address is SHA-256 over the serialized ContractState
// plus the nonce, so a single byte of drift is a different circle.
//
// Run from the repo root (contract/managed must exist — `bun run compile:contract`):
//   node --import tsx packages/midnight-native/scripts/dump-circle-deploy.mts
import {mkdirSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {bytes32} from '@pnyx/contract-client/bytes'
import {type CirclePrivateState, createCircleWitnesses} from '@pnyx/contract-client/circle-witnesses'
import {sampleCoinPublicKey, sampleEncryptionPublicKey} from '@midnight-ntwrk/ledger-v8'
import {createUnprovenDeployTxFromVerifierKeys} from '@midnight-ntwrk/midnight-js-contracts'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {NodeZkConfigProvider} from '@midnight-ntwrk/midnight-js-node-zk-config-provider'
import {CompiledContract} from '@midnight-ntwrk/midnight-js-protocol/compact-js'
import {Contract} from '../../../contract/managed/circle/contract/index.js'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const statePath = path.resolve(packageDir, 'rust/fixtures/circle_deploy.contract_state')
const inputsPath = path.resolve(packageDir, 'rust/fixtures/circle_deploy.inputs.json')

setNetworkId('undeployed')

const privateState: CirclePrivateState = {
  identitySk: bytes32(7),
  personaSk: bytes32(11),
  inviteSecret: bytes32(17),
}

const CIRCLE_ID = bytes32(1)
const IS_OPEN = true
const FOUNDER = bytes32(21)
/** The founder's auth key, seated in `moderatorAuth` by the constructor. Part of the address. */
const FOUNDER_AUTH = bytes32(0x61)
/**
 * The founder's identity join nullifier, seated in `joinedIdentities` beside their member leaf.
 *
 * A literal here rather than `identityJoinNullifier(CIRCLE_ID, identitySk)`: the fixture's job is to
 * pin the *state shape* the constructor writes, and a derived value would make a change in the
 * derivation look like a change in the deploy encoding.
 */
const FOUNDER_JOINED = bytes32(0x71)

// The DEPLOY path's state, not the simulator's: `initialContractState` here carries the `operations`
// map (one verifier key per entry point, ~23 KB) and the maintenance authority, and the contract
// address is a hash over all of it. The simulator produces only the ledger `data`, so comparing
// against that would leave the two largest contributors to the address unchecked.
const managedDir = path.resolve(packageDir, '../../contract/managed/circle')
const compiledContract = CompiledContract.make('Circle', Contract).pipe(
  CompiledContract.withWitnesses(createCircleWitnesses()),
  CompiledContract.withCompiledFileAssets(managedDir),
)
const unsubmitted = await createUnprovenDeployTxFromVerifierKeys(
  new NodeZkConfigProvider<string>(managedDir),
  sampleCoinPublicKey(),
  {
    compiledContract,
    initialPrivateState: privateState,
    args: [CIRCLE_ID, IS_OPEN, FOUNDER, FOUNDER_AUTH, FOUNDER_JOINED],
    signingKey: undefined,
  } as never,
  sampleEncryptionPublicKey(),
)
const state = unsubmitted.public.initialContractState

console.log('=== constructor-produced ledger state ===')
console.log(state.data.toString(false))
console.log(`\naddress the SDK derived (random nonce): ${unsubmitted.public.contractAddress}`)

const stateBytes = state.serialize()
mkdirSync(path.dirname(statePath), {recursive: true})
writeFileSync(statePath, stateBytes)
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
writeFileSync(
  inputsPath,
  `${JSON.stringify(
    {
      circleId: hex(CIRCLE_ID),
      isOpen: IS_OPEN,
      founderModerator: hex(FOUNDER),
      founderAuth: hex(FOUNDER_AUTH),
      founderJoined: hex(FOUNDER_JOINED),
    },
    null,
    2,
  )}\n`,
)
console.log(`\nwrote ${stateBytes.length} bytes to ${statePath}`)
console.log(`wrote inputs to ${inputsPath}`)
