// E2E for the phase-B on-device-proving submit seam, against the local standalone chain.
//
// This exercises the SERVICE leg of the rail end-to-end with a REAL proven transaction:
//   1. "device" leg — build an unproven `setInvite` call against a DEPLOYED circle's live state
//      (queried from the indexer), then PROVE it via the proof server → a proven-but-unbound
//      `Transaction<signature, proof, pre-binding>`, and serialize it (exactly what a device POSTs).
//   2. "service" leg — feed those bytes to `balanceAndSubmitProven` (the core of chain-client's
//      `submitProven`): deserialize → balance the DUST fee from the sponsor wallet → submit →
//      confirm.
//   3. verify — re-read the ledger from the indexer and assert `invites` gained the commitment.
//
// It runs against the **gated** circle `deploy-local` leaves behind, because that is the one whose
// moderators tree still holds alice, its founder. `setInvite` is moderator-gated, so it needs a live
// moderator and a real `moderatorPath`.
//
// It used to drive `createProposal`, which stopped existing when proposals became their own contracts
// (`docs/BOUNDED_STATE_ARCHITECTURE.md` §10) — a proposal is a *deploy*, so it exercises the deploy
// seam rather than the call seam. `setInvite` is the substitute: a moderator-gated call whose effect
// is a public ledger write the indexer can be re-read for.
//
// The on-device native prover (the Rust builders) is stubbed here by the JS proof path — the point
// of THIS test is the server seam (deserialize + balance + submit), which is engine-independent.
// The native-prover → same-bytes path is the on-device-bridge step (rollout step 4). A device-built
// **deploy** takes the same seam and is verified separately (`docs/CONTRACT_MIGRATION.md` P3): the
// Rust builder is not reachable from Node, so it is not exercised here.
//
// Run: bun run e2e:submit-proven   (stack up: `bun chain:up`; contracts deployed: `bun run e2e:local`)
import fs from 'node:fs'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {fileURLToPath} from 'node:url'
import {balanceAndSubmitProven} from '@pnyx/chain-client/submit-proven'
import {assembleWallet, ensureDust, waitForSections} from '@pnyx/chain-client/wallet'
import {inviteCommitment} from '@pnyx/contract-client/circle-derivations'
import {bytes32} from '@pnyx/contract-client/bytes'
import {type CirclePrivateState, createCircleWitnesses} from '@pnyx/contract-client/circle-witnesses'
import {LedgerParameters, ZswapChainState} from '@midnight-ntwrk/ledger-v8'
import {createUnprovenCallTxFromInitialStates} from '@midnight-ntwrk/midnight-js-contracts'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {NodeZkConfigProvider} from '@midnight-ntwrk/midnight-js-node-zk-config-provider'
import {CompiledContract} from '@midnight-ntwrk/midnight-js-protocol/compact-js'
import {createDefaultTestLogger, initializeMidnightProviders} from '@midnight-ntwrk/testkit-js'
import {NetworkId} from '@midnight-ntwrk/wallet-sdk'
import {Contract, ledger} from '../contract/managed/circle/contract/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const managedDir = path.resolve(here, '../contract/managed/circle')

const deployFile = path.resolve(here, '../.local-deploy.json')
if (!fs.existsSync(deployFile)) {
  throw new Error(`${deployFile} not found — run \`bun run e2e:local\` first to deploy the contracts`)
}
const {gatedCircleAddress} = JSON.parse(fs.readFileSync(deployFile, 'utf8')) as {gatedCircleAddress?: string}
if (gatedCircleAddress === undefined) {
  throw new Error(`${deployFile} has no gatedCircleAddress — re-run \`bun run e2e:local\``)
}

const GENESIS_SEED = process.env.LOCAL_SEED ?? '0000000000000000000000000000000000000000000000000000000000000001'
const env = {
  walletNetworkId: NetworkId.NetworkId.Undeployed,
  networkId: 'undeployed',
  indexer: 'http://127.0.0.1:8088/api/v4/graphql',
  indexerWS: 'ws://127.0.0.1:8088/api/v4/graphql/ws',
  node: 'http://127.0.0.1:9944',
  nodeWS: 'ws://127.0.0.1:9944',
  proofServer: process.env.PROOF_SERVER_URL ?? 'http://127.0.0.1:6300',
}
setNetworkId(env.networkId)

/** Alice, exactly as `deploy-local` seeded her — she is the gated circle's founder and a member. */
const privateState: CirclePrivateState = {
  identitySk: bytes32(1),
  personaSk: bytes32(11),
  inviteSecret: bytes32(21),
}

const logger = createDefaultTestLogger()
console.log(`Assembling sponsor wallet for circle ${gatedCircleAddress}…`)
const wallet = await assembleWallet(logger, env, GENESIS_SEED)
await wallet.wallet.start(wallet.zswapSecretKeys, wallet.dustSecretKey)
await waitForSections(wallet, 5 * 60_000, (s) =>
  console.log(`sync: unshielded=${s.unshielded.progress?.isStrictlyComplete() === true} dust=${s.dust.state.progress.appliedIndex}`),
)
await ensureDust(wallet as never, console.log)

const compiledContract = CompiledContract.make('PnyxCircle', Contract).pipe(
  CompiledContract.withWitnesses(createCircleWitnesses()),
  CompiledContract.withCompiledFileAssets(managedDir),
)
const providers = initializeMidnightProviders(wallet, env, {
  zkConfigPath: managedDir,
  privateStateStoreName: 'pnyx-submit-proven-e2e',
})
const zkConfigProvider = new NodeZkConfigProvider<string>(managedDir)

/** The invite commitment this run issues — distinct per run, so a re-run is not a no-op. */
const INVITE_COMMITMENT = inviteCommitment(bytes32(0x5a))

const readInviteCount = async (): Promise<number> => {
  const state = await providers.publicDataProvider.queryContractState(gatedCircleAddress)
  if (!state) {
    throw new Error('circle state unavailable from the indexer')
  }
  return [...ledger(state.data).invites].length
}

const step = async <T>(label: string, action: () => Promise<T>): Promise<T> => {
  const t0 = performance.now()
  const result = await action()
  console.log(`${label.padEnd(22)} ${(performance.now() - t0).toFixed(0).padStart(6)} ms`)
  return result
}

const before = await readInviteCount()
console.log(`\ninvites before: ${before}`)

// --- "device" leg: build + prove a setInvite tx against the live deployed state ---
const liveState = await providers.publicDataProvider.queryContractState(gatedCircleAddress)
if (!liveState) {
  throw new Error('circle state unavailable from the indexer')
}
const unsubmitted = await step('build unproven', () =>
  createUnprovenCallTxFromInitialStates(
    zkConfigProvider,
    {
      compiledContract,
      circuitId: 'setInvite',
      contractAddress: gatedCircleAddress,
      args: [INVITE_COMMITMENT, true],
      coinPublicKey: providers.walletProvider.getCoinPublicKey(),
      initialContractState: liveState,
      initialZswapChainState: new ZswapChainState(),
      ledgerParameters: LedgerParameters.initialParameters(),
      initialPrivateState: privateState,
    } as never,
    providers.walletProvider.getEncryptionPublicKey(),
  ),
)
const unprovenTx = (unsubmitted as {private: {unprovenTx: unknown}}).private.unprovenTx
const proven = await step('prove (proof server)', () => providers.proofProvider.proveTx(unprovenTx as never))
const txBytes: Uint8Array = (proven as {serialize(): Uint8Array}).serialize()
console.log(`proven-unbound tx: ${txBytes.length} bytes`)

// --- "service" leg: the exact core of chain-client submitProven ---
const result = await step('balance + submit', () => balanceAndSubmitProven(providers as never, txBytes))
console.log(`submitted: txId=${result.txId} blockHeight=${result.blockHeight}`)

// --- verify ---
const after = await readInviteCount()
console.log(`invites after:  ${after}`)
if (after !== before + 1) {
  throw new Error(`FAILED: the invite was not recorded (before ${before}, after ${after})`)
}
console.log('\n✔ submitProven seam verified end-to-end: proven-unbound tx balanced + submitted, ledger advanced.')
await wallet.stop()
process.exit(0)
