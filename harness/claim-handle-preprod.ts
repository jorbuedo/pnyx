// Claim a handle on preprod, end to end: deploy the name's shell at its **derived** address, then
// `bind` it by spending the permit `grant-permit-preprod.ts` minted.
//
// Run after `preprod:deploy-payment` and `preprod:grant-permit`:
//   PREPROD_MNEMONIC="abandon … about" node --import tsx harness/claim-handle-preprod.ts [name]
//
// ⚠️ **Both transactions are built in Rust, not by the SDK**, and for different reasons.
// `ContractDeploy::new` samples its nonce from `OsRng`, so an SDK deploy gives the name a random
// address — and a name with a random address has no canonical contract, which is the entire
// uniqueness mechanism. `bind` is hand-written because the device has no Compact runtime. Both come
// out of `cargo run --example pnyx_txgen`, and both are balanced and submitted here.
//
// The permit is what makes `bind` balance: it declares `unshielded_inputs[permitColor] = 1`, which is
// a deficit the wallet funds from the permit UTxO it holds. No permit, no claim.
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {indexerPublicDataProvider} from '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {createDefaultTestLogger, initializeMidnightProviders} from '@midnight-ntwrk/testkit-js'
import {NetworkId} from '@midnight-ntwrk/wallet-sdk'
import {balanceAndSubmitProven} from '@pnyx/chain-client/submit-proven'
import {assembleWallet, currentFacadeState, saveDustState, waitForSections} from '@pnyx/chain-client/wallet'
import {bytes32} from '@pnyx/contract-client/bytes'
import {identityCommitment} from '@pnyx/contract-client/derivations'
import {encodeHandle, handleTier, validateHandle} from '@pnyx/contract-client/handle'
import {ledger} from '../contract/managed/handle/contract/index.js'
import {readPreprodWallet} from './preprod-wallet.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const rustDir = path.resolve(here, '../packages/midnight-native/rust')
const managedDir = path.resolve(here, '../contract/managed/handle')
const paymentFile = path.resolve(here, '../.preprod-payment.json')
const outFile = path.resolve(here, '../.preprod-handle.json')

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

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'))

if (!fs.existsSync(paymentFile)) {
  console.error(`No ${paymentFile}. Run \`bun run preprod:deploy-payment\` first.`)
  process.exit(2)
}
const payment = JSON.parse(fs.readFileSync(paymentFile, 'utf8')) as {contractAddress: string}

const requested = process.argv[2] ?? 'test'
const checked = validateHandle(requested)
if (!checked.ok) {
  console.error(`"${requested}" is not a valid handle: ${checked.reason}`)
  process.exit(2)
}
const nameBytes = encodeHandle(checked.handle)
const tier = handleTier(nameBytes)

// The identity claiming the name. Same secret the fixtures use, so a failure here is about the chain
// rather than about which key was in play.
const IDENTITY_SK = bytes32(0x2a)
const C = identityCommitment(IDENTITY_SK)

console.log(
  [
    '',
    '=== claim a handle on preprod ===',
    `name:     ${checked.handle} (tier ${tier}, ${nameBytes.filter((b) => b !== 0).length} bytes)`,
    `payment:  ${payment.contractAddress}`,
    `claimant: C = ${hex(C)}`,
  ].join('\n'),
)

const txgen = (args: readonly string[]): string =>
  execFileSync('cargo', ['run', '--quiet', '--release', '--example', 'pnyx_txgen', '--', ...args], {
    cwd: rustDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim()

const ttl = Math.floor(Date.now() / 1000) + 3 * 60 * 60

// 1. The shell's address and deploy transaction. The address is a hash over the initial state, so it
//    is a function of the name — anyone holding the canonical spelling derives the same one.
const deployOut = txgen([
  'handle-deploy',
  path.join(managedDir, 'keys'),
  hex(nameBytes),
  payment.contractAddress,
  env.networkId,
  String(ttl),
])
const handleAddress = deployOut.slice(0, 64)
const deployTx = unhex(deployOut.slice(64))
console.log(`\nderived handle address: ${handleAddress}\ndeploy tx: ${deployTx.length} bytes`)

const logger = createDefaultTestLogger()
const {masterSeed: seed, dustStateFile} = await readPreprodWallet()
const wallet = await assembleWallet(logger, env, seed, {dustStateFile})
await wallet.wallet.start(wallet.zswapSecretKeys, wallet.dustSecretKey)
let state = await waitForSections(wallet, 60 * 60_000, (s) => {
  const d = s.dust.state.progress
  console.log(`sync: dust=${d.appliedIndex}/${d.highestRelevantWalletIndex}`)
})
while (state.dust.balance(new Date()) === 0n) {
  console.log('Waiting for DUST…')
  await new Promise((resolve) => setTimeout(resolve, 30_000))
  state = await currentFacadeState(wallet)
}
console.log(`DUST: ${state.dust.balance(new Date())}`)

const providers = initializeMidnightProviders(wallet, env, {
  zkConfigPath: managedDir,
  privateStateStoreName: 'pnyx-preprod-handle-state',
})
const reader = indexerPublicDataProvider(env.indexer, env.indexerWS)

// 2. Deploy the shell — unless the name already exists, which is itself the uniqueness property
//    working and not an error to hide.
const existing = await reader.queryContractState(handleAddress)
if (existing) {
  console.log('The shell is already deployed at that address — this name has been claimed before.')
} else {
  console.log('\nDeploying the shell…')
  const deployed = await balanceAndSubmitProven(providers as never, deployTx, (m) => console.log(`  ${m}`))
  console.log(`shell deployed: tx ${deployed.txId} @ block ${deployed.blockHeight}`)
}

// 3. Bind. The transcript is built against the *live* state, so it has to be fetched first.
const shellState = await reader.queryContractState(handleAddress)
if (!shellState) throw new Error(`no contract state at the derived address ${handleAddress}`)
const shellFile = path.join(rustDir, 'target', 'preprod-handle.contract_state')
fs.writeFileSync(shellFile, (shellState as {serialize(): Uint8Array}).serialize())

const before = ledger((shellState as unknown as {data: Parameters<typeof ledger>[0]}).data)
console.log(`\nshell on chain: name=${hex(before.name)} owner=${hex(before.owner)} banned=${before.banned}`)
if (hex(before.name) !== hex(nameBytes)) {
  throw new Error(`the contract at that address is sealed to a different name — derivation drift`)
}

console.log('\nBuilding bind natively (real proof)…')
const t0 = performance.now()
const bindTx = unhex(txgen(['bind', managedDir, shellFile, handleAddress, hex(IDENTITY_SK), env.networkId, String(ttl)]))
console.log(`bind tx built in ${(performance.now() - t0).toFixed(0)} ms (${bindTx.length} bytes)`)

console.log('Balancing and submitting — the permit is the unshielded input this needs…')
const bound = await balanceAndSubmitProven(providers as never, bindTx, (m) => console.log(`  ${m}`))
console.log(`bind: tx ${bound.txId} @ block ${bound.blockHeight}`)

// 4. Read it back. The owner cell is the claim.
const afterState = await reader.queryContractState(handleAddress)
if (!afterState) throw new Error('no contract state after bind')
const after = ledger((afterState as unknown as {data: Parameters<typeof ledger>[0]}).data)
console.log(`\n=== ${checked.handle} on chain ===\naddress: ${handleAddress}\nowner:   ${hex(after.owner)}`)
if (hex(after.owner) !== hex(C)) {
  throw new Error(`owner is ${hex(after.owner)}, expected the claimant's C ${hex(C)}`)
}
console.log(`✔ owner is the claimant's C — "${checked.handle}" is claimed.`)

fs.writeFileSync(
  outFile,
  `${JSON.stringify(
    {
      network: 'preprod',
      handle: checked.handle,
      tier,
      address: handleAddress,
      owner: hex(C),
      bindTxId: bound.txId,
      blockHeight: bound.blockHeight,
      claimedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
)
console.log(`Recorded → ${outFile}`)
await saveDustState(wallet as never, dustStateFile)
await wallet.stop()
process.exit(0)
