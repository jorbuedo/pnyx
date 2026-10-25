// Regenerates rust/fixtures/join.* — the initial ContractState and inputs the Rust
// proving test builds `join` against. Executes it offline against a fresh simulated
// ledger (createUnprovenCallTxFromInitialStates, no node/indexer — same recipe as
// harness/prove-latency.ts) and extracts the call's PreProof from the unproven transaction.
//
// Inputs are fixed so the fixture is deterministic where it matters. join needs no ledger
// setup beyond the constructor: the circle is open, the identity has not joined, the members tree is
// empty. `circleId` is now a constructor argument rather than a circuit one, because the circle IS
// the contract (docs/CONTRACT_TOPOLOGY.md split 2).
//
// .mts: this package has no `"type": "module"`, and midnight-js-protocol's CJS build requires
// the unpublished `@midnight-ntwrk/compact-js` — the ESM build is the working path.
// Run from the repo root (contract/managed must exist — `bun run compile:contract`):
//   node --import tsx packages/midnight-native/scripts/dump-join-preimage.mts
import {mkdirSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {bytes32} from '@pnyx/contract-client/bytes'
import {inviteCommitment, personaCommitment} from '@pnyx/contract-client/circle-derivations'
import {createCircleSimulator} from '@pnyx/contract-client/circle-simulator'
import {type CirclePrivateState, createCircleWitnesses} from '@pnyx/contract-client/circle-witnesses'
import {
  type ContractCall,
  LedgerParameters,
  type PreProof,
  sampleEncryptionPublicKey,
  ZswapChainState,
} from '@midnight-ntwrk/ledger-v8'
import {createUnprovenCallTxFromInitialStates} from '@midnight-ntwrk/midnight-js-contracts'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {NodeZkConfigProvider} from '@midnight-ntwrk/midnight-js-node-zk-config-provider'
import {CompiledContract} from '@midnight-ntwrk/midnight-js-protocol/compact-js'
import {Contract} from '../../../contract/managed/circle/contract/index.js'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const managedDir = path.resolve(packageDir, '../../contract/managed/circle')


setNetworkId('undeployed')

const privateState: CirclePrivateState = {
  identitySk: bytes32(7),
  personaSk: bytes32(11),
  inviteSecret: bytes32(17),
}

const CIRCLE_ID = bytes32(1)
/**
 * The founder, who is not this joiner.
 *
 * ⚠️ A **commitment of a known secret**, not an arbitrary 32 bytes: `setInvite` is moderator-gated
 * and `requireModerator` recomputes `personaCommitment(personaSk())`, so with an unrelated leaf
 * seated there is no way to issue the invite the gated fixture redeems.
 */
const FOUNDER_SK = bytes32(21)
const FOUNDER = personaCommitment(FOUNDER_SK)
const founderState: CirclePrivateState = {
  identitySk: bytes32(23),
  personaSk: FOUNDER_SK,
  inviteSecret: bytes32(29),
}
/**
 * The founder's join nullifier, seated beside their member leaf.
 *
 * A distinct literal rather than the joiner's: the constructor spends the *founder's* identity, and
 * if the two collided this fixture's join would fail as an identity that had already joined — which
 * would look like a broken transcript rather than a badly chosen constant.
 */
const FOUNDER_JOINED = bytes32(0x71)

const zkConfigProvider = new NodeZkConfigProvider<string>(managedDir)
const compiledContract = CompiledContract.make('Circle', Contract).pipe(
  CompiledContract.withWitnesses(createCircleWitnesses()),
  CompiledContract.withCompiledFileAssets(managedDir),
)

/**
 * Open or gated, chosen by argument — `join` is one circuit with two transcripts, and the gated one
 * is what the device rail could not build until now.
 *
 * A gated circle seals `isOpen: false` into its state and therefore into its address, so the two
 * cannot share a simulator: this is a different contract, not a different call.
 */
const GATED = process.argv[2] === 'gated'
const suffix = GATED ? '_gated' : ''
const outPath = path.resolve(packageDir, `rust/fixtures/join${suffix}.preimage`)
const statePath = path.resolve(packageDir, `rust/fixtures/join${suffix}.contract_state`)
const inputsPath = path.resolve(packageDir, `rust/fixtures/join${suffix}.inputs.json`)

const sim = createCircleSimulator(privateState, {
  circleId: CIRCLE_ID,
  isOpen: !GATED,
  founderModerator: FOUNDER,
  founderAuth: bytes32(0x61),
  founderJoined: FOUNDER_JOINED,
})
if (GATED) {
  // The founder issues the invite this join redeems, then the caller goes back to the joiner — the
  // simulator calls as whoever its private state names.
  sim.setPrivateState(founderState)
  sim.call('setInvite', inviteCommitment(privateState.inviteSecret), true)
  sim.setPrivateState(privateState)
}
// The fresh, constructor-produced contract state join runs against (empty
// joinedIdentities set, empty members tree). Captured before the call so the Rust builder can
// deserialize the exact same starting ledger and reproduce the transcript.
const initialContractState = sim.getContractState()
const unsubmitted = await createUnprovenCallTxFromInitialStates(
  zkConfigProvider,
  {
    compiledContract,
    circuitId: 'join',
    contractAddress: sim.contractAddress,
    args: [],
    coinPublicKey: sim.coinPublicKey,
    initialContractState,
    initialZswapChainState: new ZswapChainState(),
    ledgerParameters: LedgerParameters.initialParameters(),
    initialPrivateState: privateState,
  } as never,
  sampleEncryptionPublicKey(),
)

const tx = unsubmitted.private.unprovenTx
const intents = tx.intents
if (intents === undefined) throw new Error('unproven tx has no intents')
const calls = [...intents.values()].flatMap((intent) =>
  intent.actions.filter((a): a is ContractCall<PreProof> => 'proof' in a && a.proof.instance === 'pre-proof'),
)
const call = calls[0]
if (call === undefined || calls.length !== 1) {
  throw new Error(`expected exactly one contract call with a pre-proof, found ${calls.length}`)
}

const bytes = call.proof.serialize()
mkdirSync(path.dirname(outPath), {recursive: true})
writeFileSync(outPath, bytes)
console.log(`wrote ${bytes.length} bytes to ${outPath} (entry point: ${String(call.entryPoint)})`)

// Initial contract state + call inputs, so the Rust builder can reconstruct the preimage
// from scratch (rust/src/preimage.rs) rather than reading the preimage fixture above.
const stateBytes = initialContractState.serialize()
writeFileSync(statePath, stateBytes)
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
writeFileSync(
  inputsPath,
  `${JSON.stringify(
    {
      contractAddress: sim.contractAddress,
      coinPublicKey: sim.coinPublicKey,
      circleId: hex(CIRCLE_ID),
      identitySk: hex(privateState.identitySk),
      personaSk: hex(privateState.personaSk),
      ...(GATED ? {inviteSecret: hex(privateState.inviteSecret)} : {}),
    },
    null,
    2,
  )}\n`,
)
console.log(`wrote ${stateBytes.length} bytes to ${statePath}`)
console.log(`wrote inputs to ${inputsPath} (contractAddress ${sim.contractAddress})`)
