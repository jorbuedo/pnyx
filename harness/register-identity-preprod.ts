// Register an identity row on preprod from the host, so a phone never has to.
//
// **Why this exists.** Publishing a row needs someone to pay a DUST fee, which needs a synced,
// funded wallet. The wallet SDK is WASM and Hermes has no WebAssembly, so the phone cannot run one —
// see docs/mobile-shell-plan.md, phase 5 ("path 2 (Hermes WASM) is DEAD"). Normally the content
// service's sponsor pays; with no stateful host deployed, nothing does, and `POST /register` 503s.
//
// **The trick.** An identity *is* its recovery phrase. Nothing binds it to the device it was born
// on: `phrase → seed → forumRoot → identitySk → C` is pure derivation. So register the identity here
// — where a funded wallet exists — and then type the same phrase into the app's restore flow. The
// device ends up holding an identity whose row is already on chain, so `ensureIdentityRegistered`
// finds it and never calls `/register`. Once per identity, ever.
//
// Every value written here is derived exactly as the app derives it. The `anchor` in particular is
// the **MLS signature key**, not `authPub`: publishing the wrong one lets login succeed while every
// incoming DM dies as `key-package-rejected`, which has shipped broken once already.
//
// Usage:
//   bun run preprod:register-identity                 # generates a fresh 24-word phrase
//   bun run preprod:register-identity "word1 … word24" # registers an existing one
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assembleWallet, ensureDust, saveDustState, waitForSections } from '@pnyx/chain-client/wallet'
import { readPreprodWallet } from './preprod-wallet.js'
import { authKeyPair, encodePnyxId, identityCommitmentOf, identitySkFromForumRoot } from '@pnyx/contract-client/identity'
import { forumRoot } from '@pnyx/contract-client/persona'
import { type IdentityPrivateState, createIdentityWitnesses } from '@pnyx/contract-client/identity-witnesses'
import { ed25519PublicKey, hkdfSha256, utf8 } from '@pnyx/crypto'
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts'
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id'
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js'
import { createDefaultTestLogger, initializeMidnightProviders } from '@midnight-ntwrk/testkit-js'
import { NetworkId } from '@midnight-ntwrk/wallet-sdk'
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { Effect } from 'effect'
import { Contract, ledger } from '../contract/managed/identity/contract/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const managedDir = path.resolve(here, '../contract/managed/identity')
const deployFile = path.resolve(here, '../.preprod-deploy.json')

const NETWORK = 'preprod'
const env = {
  walletNetworkId: NetworkId.NetworkId.PreProd,
  networkId: NETWORK,
  indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
  indexerWS: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
  node: 'https://rpc.preprod.midnight.network',
  nodeWS: 'wss://rpc.preprod.midnight.network',
  proofServer: process.env.PROOF_SERVER_URL ?? 'http://127.0.0.1:6300',
}
setNetworkId(env.networkId)

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

// ── the identity, derived exactly as the app does ──

const argPhrase = process.argv.slice(2).join(' ').trim()
const phrase = argPhrase === '' ? generateMnemonic(wordlist, 256) : argPhrase
if (!validateMnemonic(phrase, wordlist)) {
  console.error('That is not a valid BIP-39 phrase.')
  process.exit(2)
}

const seed = mnemonicToSeedSync(phrase)
const root = forumRoot(seed)
const identitySk = identitySkFromForumRoot(root)
const pnyxId = encodePnyxId(identityCommitmentOf(identitySk))
const auth = authKeyPair(identitySk)
// ⚠️ dm-mls.ts's deriveMlsIdentity, reproduced from its primitives so this harness needs no RN import.
// The info string must stay byte-identical to `SIG_INFO` there — it decides the row's `anchor`, and a
// drift publishes an anchor no client can match. It has drifted once already (this copy kept
// `:v1:<network>` after the real one dropped both).
const mlsSignKey = Effect.runSync(hkdfSha256(root, utf8.encode('pnyx:dm:mls:sig'), 32))
const anchor = ed25519PublicKey(mlsSignKey)

console.log(
  [
    '',
    '=== Identity to register ===',
    `pnyx_id: ${pnyxId}`,
    `anchor  : ${hex(anchor)}   (MLS signature key)`,
    `authPub : ${hex(auth.publicKey)}   (login key)`,
    '',
  ].join('\n'),
)

// ── publish it, paid by the funded preprod wallet ──

const { contractAddress, network } = JSON.parse(fs.readFileSync(deployFile, 'utf8')) as {
  contractAddress: string
  network: string
}
if (network !== NETWORK) throw new Error(`${deployFile} records ${network}, not ${NETWORK}`)

const { masterSeed, dustStateFile, source } = await readPreprodWallet()
console.log(`wallet: ${source}`)
const logger = createDefaultTestLogger()
const wallet = await assembleWallet(logger, env, masterSeed, { dustStateFile })
await wallet.wallet.start(wallet.zswapSecretKeys, wallet.dustSecretKey)
await waitForSections(wallet, 45 * 60_000, (s) => {
  const d = s.dust.state.progress
  console.log(`sync: unshielded=${s.unshielded.progress?.isStrictlyComplete() === true} dust=${d.appliedIndex}/${d.highestRelevantWalletIndex}`)
})
await saveDustState(wallet as never, dustStateFile)
await ensureDust(wallet as never, console.log)

// The witness the circuit proves knowledge of. Only `identitySk` matters: it is what addresses the
// row, so this transaction can only ever write the identity derived above.
const privateState: IdentityPrivateState = {identitySk}
const compiledContract = CompiledContract.make('PnyxIdentity', Contract).pipe(
  CompiledContract.withWitnesses(createIdentityWitnesses()),
  CompiledContract.withCompiledFileAssets(managedDir),
)
const providers = initializeMidnightProviders(wallet, env, {
  zkConfigPath: managedDir,
  privateStateStoreName: 'pnyx-preprod-private-state',
})
const deployed = await findDeployedContract(providers as never, {
  compiledContract,
  contractAddress,
  privateStateId: 'pnyxPreprodRegister',
  initialPrivateState: privateState,
} as never)

type CallTx = Readonly<{ publishRow: (anchor: unknown, authPub: unknown) => Promise<unknown> }>
console.log(`Publishing the row to ${contractAddress}…`)
const started = performance.now()
await (deployed as unknown as { callTx: CallTx }).callTx.publishRow(anchor, auth.publicKey)
console.log(`published in ${(performance.now() - started).toFixed(0)} ms`)

// Read it back through the indexer — the same source the app and the Worker read.
const state = await providers.publicDataProvider.queryContractState(contractAddress)
if (!state) throw new Error('no contract state after publishing')
const view = ledger((state as unknown as { data: Parameters<typeof ledger>[0] }).data)
const C = identityCommitmentOf(identitySk)
// One contract per identity: the row is the contract's own cells, and `id` is what the address means.
if (hex(view.id) !== hex(C)) throw new Error(`contract sealed to ${hex(view.id)}, not ${hex(C)} — derivation drift`)
if (hex(view.authPub) !== hex(auth.publicKey)) throw new Error('stored authPub is not the derived one')
if (hex(view.anchor) !== hex(anchor)) throw new Error('stored anchor is not the MLS signature key')

console.log(
  [
    '',
    '=== Registered ===',
    `pnyx_id: ${pnyxId}`,
    'Row verified on chain: authPub and anchor match what the app will derive.',
    '',
    'Now restore this phrase in the app (Onboarding → I already have an identity):',
    '',
    `  ${phrase}`,
    '',
    'Keep it: it IS the identity. Nothing else needs to be transferred from this machine.',
    '',
  ].join('\n'),
)

await wallet.stop()
