// Deploy a circle on preprod at its **derived** address, then join it — both transactions built in
// Rust, balanced and submitted here.
//
// Run:
//   PREPROD_MNEMONIC="abandon … about" node --import tsx harness/deploy-circle-preprod.ts [content-circle-id]
//
// ⚠️ **Why Rust builds both, and it is not the same reason twice.**
// `ContractDeploy::new` samples its nonce from `OsRng` and the wasm binding exposes no alternative, so
// an SDK-built deploy gives the circle a random address — and a circle with a random address has no
// canonical contract, only what a registry claims. That is not cosmetic here: `circle.compact`'s
// constructor seats `founder` in `moderators`, so whoever controls the address controls invites, bans
// and moderator promotion for the circle's life. `join` is hand-written because there is no Compact
// runtime on the rail that has to build it; it is proved natively against the SRS in
// `~/.cache/midnight/zk-params`.
//
// ⚠️ **A proof server on :6300 is still required, and not for our circuits.** The deploy carries no
// circuit proof at all (a `ContractDeploy` is state plus verifier keys) and `join` is proved natively —
// but `balanceTx` pays the fee from DUST, and the wallet-sdk proves that **dust spend** through the
// proof server. So a run with no proof server dies at the *deploy*, which is the step that looks least
// like it needs one: `Wallet.Proving: Failed to prove transaction` wrapping
// `Failed to connect to Proof Server (POST http://127.0.0.1:6300/prove)`.
// Use `127.0.0.1`, never `localhost` — Node 22 resolves it to `::1` and the rootless-podman forward is
// IPv4-only.
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
import {identityJoinNullifier, personaCommitment} from '@pnyx/contract-client/circle-derivations'
import {moderatorAuthKeyPair} from '@pnyx/contract-client/persona'
import {circleIdFromContentId} from '@pnyx/contract-client/circle-id'
import {ledger} from '../contract/managed/circle/contract/index.js'
import {readPreprodWallet} from './preprod-wallet.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const rustDir = path.resolve(here, '../packages/midnight-native/rust')
const managedDir = path.resolve(here, '../contract/managed/circle')
const outFile = path.resolve(here, '../.preprod-circle.json')

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

const contentCircleId = process.argv[2] ?? 'pnyx-preprod-demo'
const circleId = circleIdFromContentId(contentCircleId)

// The founder, and the first member. Same shape as `harness/circle-lifecycle.test.ts`'s `alice`, so a
// failure here is about the chain rather than about which key was in play.
const IDENTITY_SK = bytes32(1)
const PERSONA_SK = bytes32(11)
const founder = personaCommitment(PERSONA_SK)
// Seated by the constructor alongside the founder, and both feed the address — so they are not
// optional extras: `circle-deploy` reads eight arguments and this script passed six, which is why it
// could not run at all. Derived exactly as `services/pnyx-proving.ts` does for a real deploy, rather
// than with the simulator's placeholder, so the founder can actually moderate what it deploys.
const founderAuth = moderatorAuthKeyPair(PERSONA_SK).publicKey
const founderJoined = identityJoinNullifier(circleId, IDENTITY_SK)

// The circle is open: `isOpen` is sealed into the initial state and therefore into the address, so
// this is not a runtime flag but part of what the circle *is*.
const IS_OPEN = true

console.log(
  [
    '',
    '=== deploy a circle on preprod ===',
    `content id: ${contentCircleId}`,
    `circleId:   ${hex(circleId)}`,
    `founder:    ${hex(founder)} (persona commitment, seated in moderators)`,
    `open:       ${IS_OPEN}`,
  ].join('\n'),
)

const txgen = (args: readonly string[]): string =>
  execFileSync('cargo', ['run', '--quiet', '--release', '--example', 'pnyx_txgen', '--', ...args], {
    cwd: rustDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim()

const ttl = Math.floor(Date.now() / 1000) + 3 * 60 * 60

// 1. The address and the deploy transaction. The address is a hash over the initial state plus a nonce
//    derived from `circleId`, so anyone holding (circleId, isOpen, founder) and this template derives
//    the same one offline — which is what makes it canonical rather than claimed.
const deployOut = txgen([
  'circle-deploy',
  path.join(managedDir, 'keys'),
  hex(circleId),
  String(IS_OPEN),
  hex(founder),
  hex(founderAuth),
  hex(founderJoined),
  env.networkId,
  String(ttl),
])
const circleAddress = deployOut.slice(0, 64)
const deployTx = unhex(deployOut.slice(64))
console.log(`\nderived circle address: ${circleAddress}\ndeploy tx: ${deployTx.length} bytes`)

const logger = createDefaultTestLogger()
const {masterSeed: seed, dustStateFile} = await readPreprodWallet()
const wallet = await assembleWallet(logger, env, seed, {dustStateFile})
await wallet.wallet.start(wallet.zswapSecretKeys, wallet.dustSecretKey)
// ⚠️ Preprod carries >1.2M dust events; with no snapshot beside the wallet this is a cold sync of
// ~15 minutes or more, and the progress line is the only sign it is alive.
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
  privateStateStoreName: 'pnyx-preprod-circle-state',
})
const reader = indexerPublicDataProvider(env.indexer, env.indexerWS)

// 2. Deploy — unless this circle already exists, which is the derived address working rather than a
//    failure to hide.
const existing = await reader.queryContractState(circleAddress)
if (existing) {
  console.log('Already deployed at that address — this circle id has been deployed before.')
} else {
  console.log('\nDeploying the circle…')
  const deployed = await balanceAndSubmitProven(providers as never, deployTx, (m) => console.log(`  ${m}`))
  console.log(`circle deployed: tx ${deployed.txId} @ block ${deployed.blockHeight}`)
}

// 3. Join. The transcript runs against the *live* state, so it has to be fetched first — and read back
//    to confirm the contract at that address is sealed to the circleId we derived it from.
const circleState = await reader.queryContractState(circleAddress)
if (!circleState) throw new Error(`no contract state at the derived address ${circleAddress}`)
const stateFile = path.join(rustDir, 'target', 'preprod-circle.contract_state')
fs.writeFileSync(stateFile, (circleState as {serialize(): Uint8Array}).serialize())

const before = ledger((circleState as unknown as {data: Parameters<typeof ledger>[0]}).data)
console.log(`\non chain: circleId=${hex(before.circleId)} isOpen=${before.isOpen}`)
if (hex(before.circleId) !== hex(circleId)) {
  throw new Error('the contract at that address is sealed to a different circleId — derivation drift')
}

if (before.joinedIdentities.member(founderJoined)) {
  console.log('This identity has already joined — nothing to do.')
} else {
  console.log('\nBuilding join natively (real proof, K14)…')
  const t0 = performance.now()
  const joinTx = unhex(
    txgen([
      'join',
      managedDir,
      stateFile,
      circleAddress,
      hex(circleId),
      hex(IDENTITY_SK),
      hex(PERSONA_SK),
      env.networkId,
      String(ttl),
    ]),
  )
  console.log(`join tx built in ${(performance.now() - t0).toFixed(0)} ms (${joinTx.length} bytes)`)

  const landed = await balanceAndSubmitProven(providers as never, joinTx, (m) => console.log(`  ${m}`))
  console.log(`join: tx ${landed.txId} @ block ${landed.blockHeight}`)
}

// 4. Read it back. Membership is the leaf being in the tree — and the join nullifier being spent is
//    what stops this identity ever joining twice.
const afterState = await reader.queryContractState(circleAddress)
if (!afterState) throw new Error('no contract state after join')
const after = ledger((afterState as unknown as {data: Parameters<typeof ledger>[0]}).data)
const memberPath = after.members.findPathForLeaf(founder)
console.log(
  [
    '',
    `=== ${contentCircleId} on chain ===`,
    `address:   ${circleAddress}`,
    `member:    ${memberPath === undefined ? 'NOT FOUND' : 'leaf is in the members tree'}`,
    `nullifier: ${after.joinedIdentities.member(founderJoined) ? 'spent' : 'ABSENT'}`,
  ].join('\n'),
)
if (memberPath === undefined) throw new Error("the founder's persona is not in the members tree after join")
if (!after.joinedIdentities.member(founderJoined)) throw new Error('the join nullifier was not recorded')
console.log('✔ the circle is deployed and its founder is a member.')

fs.writeFileSync(
  outFile,
  `${JSON.stringify(
    {
      network: 'preprod',
      contentCircleId,
      circleId: hex(circleId),
      address: circleAddress,
      isOpen: IS_OPEN,
      founder: hex(founder),
      deployedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
)
console.log(`Recorded → ${outFile}`)
await saveDustState(wallet as never, dustStateFile)
await wallet.stop()
process.exit(0)
