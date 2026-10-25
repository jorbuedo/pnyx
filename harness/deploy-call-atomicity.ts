// Can one transaction deploy a contract AND call it? And does a failing action kill its siblings?
//
// The whole naming design in `docs/BOUNDED_STATE_ARCHITECTURE.md` rests on this. A `handle(name)`
// shell cannot bind its own deployer — the address must be a function of the name alone, and Midnight
// has no `msg.sender` — so "only the claimant owns it" comes entirely from deploy and bind landing in
// one transaction. If that does not hold, every claim is a land-grab race.
//
// Three experiments against the standalone `undeployed` chain:
//
//   E1  deploy + a valid call, one transaction        -> does the pair land at all?
//   E1b deploy alone                                  -> control
//   E2  the same deploy intent reused                 -> inconclusive: replay protection fires first
//   E3  a fresh deploy + a call to a DIFFERENT
//       existing contract, one tx                     -> do deploys and calls compose at all?
//
// Result: E1 fails and E3 succeeds. A transaction may carry deploys and calls together, but it may
// never call a contract it created — `verify.rs:104` `get_op` resolves the call's verifier key from the
// *pre-transaction* ledger state, so a same-transaction deploy's key is not there to verify against.
//
// Run: bun run chain:up, then node --import tsx harness/deploy-call-atomicity.ts
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {LedgerParameters, ZswapChainState} from '@midnight-ntwrk/ledger-v8'
import {createUnprovenCallTxFromInitialStates, createUnprovenDeployTx} from '@midnight-ntwrk/midnight-js-contracts'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {NodeZkConfigProvider} from '@midnight-ntwrk/midnight-js-node-zk-config-provider'
import {CompiledContract} from '@midnight-ntwrk/midnight-js-protocol/compact-js'
import {createDefaultTestLogger, initializeMidnightProviders} from '@midnight-ntwrk/testkit-js'
import {NetworkId} from '@midnight-ntwrk/wallet-sdk'
import {balanceAndSubmitProven} from '@pnyx/chain-client/submit-proven'
import {assembleWallet, ensureDust, nightRaw, waitForSections} from '@pnyx/chain-client/wallet'
import {bytes32} from '@pnyx/contract-client/bytes'
import {identityCommitment} from '@pnyx/contract-client/derivations'
import {createIdentityWitnesses, type IdentityPrivateState} from '@pnyx/contract-client/identity-witnesses'
import {Contract, ledger} from '../contract/managed/identity/contract/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const managedDir = path.resolve(here, '../contract/managed/identity')
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

const ALICE: IdentityPrivateState = {identitySk: bytes32(0xa1)}

const logger = createDefaultTestLogger()
const wallet = await assembleWallet(logger, env, GENESIS_SEED)
await wallet.wallet.start(wallet.zswapSecretKeys, wallet.dustSecretKey)
await waitForSections(wallet, 5 * 60_000, () => {})
if ((await waitForSections(wallet, 60_000, () => {})).unshielded.balances[nightRaw()] === 0n) {
  throw new Error('genesis wallet has no NIGHT — is the node up with CFG_PRESET=dev?')
}
await ensureDust(wallet as never, () => {})

const providers = initializeMidnightProviders(wallet, env, {
  zkConfigPath: managedDir,
  privateStateStoreName: 'pnyx-atomicity',
})
const zk = new NodeZkConfigProvider<string>(managedDir)
const compiled = CompiledContract.make('PnyxIdentity', Contract).pipe(
  CompiledContract.withWitnesses(createIdentityWitnesses()),
  CompiledContract.withCompiledFileAssets(managedDir),
)

type Unproven = {serialize(): Uint8Array; merge(other: unknown): Unproven}

/** An unproven deploy, plus the address and initial state it will create. */
const buildDeploy = async () => {
  const d = (await createUnprovenDeployTx(providers as never, {
    compiledContract: compiled,
    privateStateId: 'atomicity',
    initialPrivateState: ALICE,
    args: [identityCommitment(ALICE.identitySk)],
  } as never)) as unknown as {
    private: {unprovenTx: Unproven}
    public: {contractAddress: string; initialContractState: unknown}
  }
  return {tx: d.private.unprovenTx, address: d.public.contractAddress, state: d.public.initialContractState}
}

/** An unproven call built against a state the caller supplies — no chain read. */
const buildCall = async (address: string, state: unknown, anchor: number) => {
  const c = (await createUnprovenCallTxFromInitialStates(
    zk,
    {
      compiledContract: compiled,
      circuitId: 'publishRow',
      contractAddress: address,
      args: [bytes32(anchor), bytes32(anchor + 1)],
      coinPublicKey: providers.walletProvider.getCoinPublicKey(),
      initialContractState: state,
      initialZswapChainState: new ZswapChainState(),
      ledgerParameters: LedgerParameters.initialParameters(),
      initialPrivateState: ALICE,
    } as never,
    providers.walletProvider.getEncryptionPublicKey(),
  )) as unknown as {private: {unprovenTx: Unproven}}
  return c.private.unprovenTx
}

const submit = async (label: string, unproven: Unproven) => {
  try {
    const proven = (await providers.proofProvider.proveTx(unproven as never)) as {serialize(): Uint8Array}
    const r = await balanceAndSubmitProven(providers as never, proven.serialize())
    console.log(`  ${label}: ACCEPTED  txId=${(r as {txId: string}).txId}`)
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`  ${label}: REJECTED  ${msg.slice(0, 150)}`)
    return false
  }
}

const readState = async (address: string) => {
  const st = await providers.publicDataProvider.queryContractState(address)
  if (!st) return null
  const l = ledger(st.data)
  // `rows` is 1 once `publishRow` has run: there is one row per contract now, so a written row is
  // what a landed call looks like.
  return {rows: l.anchor.some((b) => b !== 0) ? 1 : 0, names: l.primaryName.some((b) => b !== 0) ? 1 : 0}
}

console.log('\n=== E1: deploy + valid call, one transaction ===')
const d1 = await buildDeploy()
console.log(`  address ${d1.address}`)
const c1 = await buildCall(d1.address, d1.state, 0x70)
const e1 = await submit('deploy+call', d1.tx.merge(c1))
const s1 = await readState(d1.address)
console.log(`  state after: ${s1 === null ? 'CONTRACT ABSENT' : `${s1.rows} identity row(s), ${s1.names} names`}`)
if (e1 && s1 !== null && s1.rows === 1) {
  console.log('  => a deploy and a call to it CAN share one transaction, and the call applied.')
} else if (e1 && s1 !== null) {
  console.log('  => the deploy landed but the call did NOT apply.')
}

console.log('\n=== E1b: the same deploy ALONE, so the contract exists for E2 ===')
const e1b = await submit('deploy alone', d1.tx)
const s1b = await readState(d1.address)
console.log(`  contract present: ${s1b !== null}${s1b ? ` (${s1b.rows} rows, ${s1b.names} names)` : ''}`)

console.log('\n=== E2: reusing the same deploy intent + a call to the now-existing contract ===')
console.log('  ⚠️ INCONCLUSIVE by construction: reusing an intent trips replay protection')
console.log('  (ReplayProtectionViolation(IntentAlreadyExists)) before the duplicate-deploy path is')
console.log('  reached. JS randomises the deploy nonce, so two DISTINCT intents deploying one address')
console.log('  cannot be built here — that needs the Rust rail. Moot anyway: E1 forces deploy and bind')
console.log('  into separate transactions, so a failed deploy can no longer take a bind down with it.')
const c2 = await buildCall(d1.address, d1.state, 0x80)
const before2 = await readState(d1.address)
const e2 = await submit('dupdeploy+call', d1.tx.merge(c2))
const after2 = await readState(d1.address)
console.log(`  rows before ${before2?.rows} -> after ${after2?.rows}`)
console.log(`  ${e2 ? 'accepted' : 'rejected'} — read the node log for which check fired.`)

console.log('\n=== E3: a fresh deploy + a valid call to the OTHER (existing) contract ===')
console.log('  does an unrelated deploy ride along with a call, when the call needs no new contract?')
const d3 = await buildDeploy()
const c3 = await buildCall(d1.address, d1.state, 0x90)
const e3 = await submit('newdeploy+othercall', d3.tx.merge(c3))
const s3 = await readState(d3.address)
console.log(`  new contract present: ${s3 !== null}`)
if (e3) console.log('  => yes: deploys and calls compose freely as long as no call targets a same-tx deploy.')

console.log('\n--- summary ---')
console.log(`E1  call a contract the SAME tx deploys : ${e1 ? 'works' : 'REJECTED — Malformed(ContractNotPresent)'}`)
console.log(`E1b deploy alone                        : ${e1b ? 'works' : 'FAILS'}`)
console.log(`E2  same intent reused                  : ${e2 ? 'accepted' : 'rejected (replay protection — inconclusive, and moot)'}`)
console.log(`E3  unrelated deploy + call to existing : ${e3 ? 'works' : 'rejected'}`)
await wallet.stop()
process.exit(0)
