// Spike 2 — real proof latency per circuit through the local proof server.
// For each circuit: drive the simulator to the circuit's pre-state, build an unproven
// call transaction offline (createUnprovenCallTxFromInitialStates — no node/indexer),
// then time ProofProvider.proveTx against PROOF_SERVER_URL (default localhost:6300).
// Run: node --import tsx harness/prove-latency.ts
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {fileURLToPath} from 'node:url'
import {bytes32} from '@pnyx/contract-client/bytes'
import {identityJoinNullifier, inviteCommitment, personaCommitment} from '@pnyx/contract-client/circle-derivations'
import {type CircleSimulator, createCircleSimulator} from '@pnyx/contract-client/circle-simulator'
import {type CirclePrivateState, createCircleWitnesses} from '@pnyx/contract-client/circle-witnesses'
import {LedgerParameters, sampleEncryptionPublicKey, ZswapChainState} from '@midnight-ntwrk/ledger-v8'
import {createUnprovenCallTxFromInitialStates} from '@midnight-ntwrk/midnight-js-contracts'
import {httpClientProofProvider} from '@midnight-ntwrk/midnight-js-http-client-proof-provider'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {NodeZkConfigProvider} from '@midnight-ntwrk/midnight-js-node-zk-config-provider'
import {CompiledContract} from '@midnight-ntwrk/midnight-js-protocol/compact-js'
import {Contract} from '../contract/managed/circle/contract/index.js'

const managedDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../contract/managed/circle')
// 127.0.0.1, not localhost — Node 22 prefers ::1 and the rootless-podman forward is IPv4-only.
const proofServerUrl = process.env.PROOF_SERVER_URL ?? 'http://127.0.0.1:6300'

setNetworkId(process.env.MIDNIGHT_NETWORK_ID ?? 'undeployed')

const privateState: CirclePrivateState = {
  identitySk: bytes32(7),
  personaSk: bytes32(11),
  inviteSecret: bytes32(17),
}

const CIRCLE_ID = bytes32(1)
/** The founder moderator, seeded by the constructor — every moderator-gated circuit needs it. */
const FOUNDER = personaCommitment(privateState.personaSk)
const OTHER = bytes32(0x5c)

type Stage = {
  readonly circuitId: string
  readonly args: readonly unknown[]
  readonly setup: (sim: CircleSimulator) => void
  /** A gated circle, for the invite path — most stages want the open one. */
  readonly gated?: boolean
}

const join = (sim: CircleSimulator) => sim.call('join')

// Each stage's setup drives the ledger to the state the circuit call runs against. Every circuit
// `circle.compact` exports is timed — eight now, since three pairs merged
// (`docs/CONTRACT_MIGRATION.md`), and the merged ones are the interesting numbers because a merged
// circuit carries both branches' constraints whichever one it takes.
const stages: readonly Stage[] = [
  // `join` twice: an open circle short-circuits the invite checks, a gated one does not, and they are
  // one entry point — so the same verifier key proves two quite different amounts of work.
  {circuitId: 'join (open)', args: [], setup: () => {}},
  {
    circuitId: 'join (gated)',
    args: [],
    gated: true,
    setup: (sim) => sim.call('setInvite', inviteCommitment(privateState.inviteSecret), true),
  },
  // `createProposal` no longer exists (a proposal is a deploy) and `castVote`/`revealVote` moved to
  // `proposal.compact`, which needs its own simulator and a sealed members root — so they are timed
  // separately once their native prototypes are ported (`docs/BOUNDED_STATE_ARCHITECTURE.md` §10).
  {circuitId: 'setInvite', args: [inviteCommitment(OTHER), true], setup: () => {}},
  {circuitId: 'addModerator', args: [FOUNDER, bytes32(0x62)], setup: join},
  {circuitId: 'setMember (ban)', args: [FOUNDER, false], setup: join},
  {circuitId: 'setMember (reinstate)', args: [OTHER, true], setup: () => {}},
  {circuitId: 'leaveCircle', args: [], setup: join},
]

const zkConfigProvider = new NodeZkConfigProvider<string>(managedDir)
const proofProvider = httpClientProofProvider(proofServerUrl, zkConfigProvider)
const encryptionPublicKey = sampleEncryptionPublicKey()

const compiledContract = CompiledContract.make('PnyxCircle', Contract).pipe(
  CompiledContract.withWitnesses(createCircleWitnesses()),
  CompiledContract.withCompiledFileAssets(managedDir),
)

const runs = Number(process.env.RUNS ?? 3)
const results: {circuitId: string; buildMs: number; proveMs: number[]}[] = []

for (const stage of stages) {
  const proveMs: number[] = []
  let buildMs = 0
  for (let run = 0; run < runs; run++) {
    const sim = createCircleSimulator(privateState, {
      circleId: CIRCLE_ID,
      isOpen: stage.gated !== true,
      founderModerator: FOUNDER,
      founderAuth: bytes32(0x61),
      founderJoined: identityJoinNullifier(CIRCLE_ID, privateState.identitySk),
    })
    stage.setup(sim)

    const tBuild = performance.now()
    const unsubmitted = await createUnprovenCallTxFromInitialStates(
      zkConfigProvider,
      {
        compiledContract,
        // The display label carries a variant suffix; the circuit id is the first word.
        circuitId: stage.circuitId.split(' ')[0],
        contractAddress: sim.contractAddress,
        args: stage.args,
        coinPublicKey: sim.coinPublicKey,
        initialContractState: sim.getContractState(),
        initialZswapChainState: new ZswapChainState(),
        ledgerParameters: LedgerParameters.initialParameters(),
        initialPrivateState: privateState,
      } as never,
      encryptionPublicKey,
    )
    buildMs = performance.now() - tBuild

    const tProve = performance.now()
    await proofProvider.proveTx(unsubmitted.private.unprovenTx)
    proveMs.push(performance.now() - tProve)
  }
  results.push({circuitId: stage.circuitId, buildMs, proveMs})
  const [first, ...rest] = proveMs
  if (first === undefined) throw new Error(`${stage.circuitId}: no prove timings recorded`)
  console.log(
    `${stage.circuitId.padEnd(18)} build ${buildMs.toFixed(0).padStart(5)}ms | prove first ${first.toFixed(0).padStart(6)}ms` +
      (rest.length > 0 ? ` | warm ${rest.map((m) => `${m.toFixed(0)}ms`).join(' ')}` : ''),
  )
}

const summary = results.map((r) => ({
  circuit: r.circuitId,
  'build (ms)': Math.round(r.buildMs),
  'prove first (ms)': Math.round(r.proveMs[0] ?? 0),
  'prove warm min (ms)': Math.round(Math.min(...(r.proveMs.slice(1).length > 0 ? r.proveMs.slice(1) : r.proveMs))),
}))
console.table(summary)
