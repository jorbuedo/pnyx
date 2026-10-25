// Deploy `contract/bench/test-shielded-token.compact` on preprod and mint a shielded coin with it.
//
// This exists because **there is no shielded token on Midnight to test with**: the faucet serves
// unshielded tNIGHT, tDUST is fee-only and non-transferable, and every shielded colour is
// `tokenType(domainSep, contract)`. Nothing can exercise `payment.buyPermitShielded` until some
// contract has minted one.
//
// Run:
//   PREPROD_MNEMONIC="abandon … about" bun run preprod:mint-token [<coinPublicKeyHex>] [<value>]
//
// With no coin public key it mints to **this wallet's own** shielded key, which is what the device
// test wants. A minted coin has no recipient it can be scanned for, so the three fields printed at
// the end are the only record of it that exists anywhere — see below.
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {deployContract, findDeployedContract} from '@midnight-ntwrk/midnight-js-contracts'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {CompiledContract} from '@midnight-ntwrk/midnight-js-protocol/compact-js'
import {createDefaultTestLogger, initializeMidnightProviders} from '@midnight-ntwrk/testkit-js'
import {NetworkId} from '@midnight-ntwrk/wallet-sdk'
import {assembleWallet, currentFacadeState, saveDustState, waitForSections} from '@pnyx/chain-client/wallet'
import {coinPublicKeyRecipient} from '@pnyx/contract-client/payment-simulator'
import {Contract} from '../contract/managed/test-shielded-token/contract/index.js'
import {readPreprodWallet} from './preprod-wallet.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const managedDir = path.resolve(here, '../contract/managed/test-shielded-token')
const outFile = path.resolve(here, '../.preprod-test-token.json')

const env = {
  walletNetworkId: NetworkId.NetworkId.PreProd,
  networkId: 'preprod',
  indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
  indexerWS: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
  node: 'https://rpc.preprod.midnight.network',
  nodeWS: 'wss://rpc.preprod.midnight.network',
  faucet: 'https://faucet.preprod.midnight.network/api/drips',
  proofServer: process.env.PROOF_SERVER_URL ?? 'http://127.0.0.1:6300',
}
setNetworkId(env.networkId)

const requestedKey = process.argv[2]
const requestedValue = process.argv[3] === undefined ? 1_000_000n : BigInt(process.argv[3])
if (requestedKey !== undefined && !/^[0-9a-f]{64}$/i.test(requestedKey)) {
  console.error(`a coin public key is 64 hex characters, got: ${requestedKey}`)
  process.exit(2)
}

const logger = createDefaultTestLogger()
const {masterSeed: seed, dustStateFile, source} = await readPreprodWallet()
console.log(`\n=== test shielded token ===\nseed from: ${source}`)

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

// This wallet's own shielded key, which is also the default mint recipient.
const ownCoinPublicKey = (wallet as unknown as {zswapSecretKeys: {coinPublicKey: string}}).zswapSecretKeys.coinPublicKey
const recipientKey = requestedKey?.toLowerCase() ?? ownCoinPublicKey
console.log(`recipient coin public key: ${recipientKey}${recipientKey === ownCoinPublicKey ? ' (this wallet)' : ''}`)

// ⚠️ **`withWitnesses({})` is required even though the contract has none.** The generated
// `Contract` constructor refuses a missing witnesses argument outright — `first (witnesses) argument
// to Contract constructor is not an object` — so "no witnesses" has to be spelled as an empty one.
const compiledContract = CompiledContract.make('PnyxTestShieldedToken', Contract).pipe(
  CompiledContract.withWitnesses({}),
  CompiledContract.withCompiledFileAssets(managedDir),
)
const providers = initializeMidnightProviders(wallet, env, {
  zkConfigPath: managedDir,
  privateStateStoreName: 'pnyx-preprod-test-token-state',
})

const existing = fs.existsSync(outFile)
  ? (JSON.parse(fs.readFileSync(outFile, 'utf8')) as {contractAddress: string})
  : undefined

const bound = existing
  ? await findDeployedContract(providers as never, {
      compiledContract,
      contractAddress: existing.contractAddress,
      privateStateId: 'pnyxTestTokenPreprod',
      initialPrivateState: {},
    } as never)
  : await deployContract(providers as never, {
      compiledContract,
      privateStateId: 'pnyxTestTokenPreprod',
      initialPrivateState: {},
      args: [],
    } as never)

const contractAddress =
  existing?.contractAddress ??
  (bound as unknown as {deployTxData: {public: {contractAddress: string}}}).deployTxData.public.contractAddress
if (existing) {
  console.log(`bound to existing minter: ${contractAddress}`)
} else {
  const {txId, blockHeight} = (bound as unknown as {deployTxData: {public: {txId: string; blockHeight: bigint}}}).deployTxData.public
  console.log(`\n=== minter deployed ===\naddress: ${contractAddress}\ntx: ${txId} @ block ${blockHeight}`)
  fs.writeFileSync(outFile, `${JSON.stringify({network: 'preprod', contractAddress, deployedAt: new Date().toISOString()}, null, 2)}\n`, {mode: 0o600})
  console.log(`Recorded → ${outFile}`)
}

type CallTx = Readonly<{mintShielded: (recipient: unknown, value: bigint) => Promise<unknown>}>
const callTx = (bound as unknown as {callTx: CallTx}).callTx

console.log(`\nMinting ${requestedValue} shielded…`)
const t0 = performance.now()
const result = (await callTx.mintShielded(
  // ⚠️ The **left** arm is the user on this rail — the opposite way round from the unshielded
  // `Either<ContractAddress, UserAddress>`. Built by the constructor that can only produce a
  // shielded recipient, so the two cannot be confused.
  coinPublicKeyRecipient(Uint8Array.from(Buffer.from(recipientKey, 'hex'))),
  requestedValue,
)) as {
  public?: {txId?: string; blockHeight?: bigint}
  private?: {result?: {nonce?: Uint8Array; color?: Uint8Array; value?: bigint}}
}
console.log(`minted in ${(performance.now() - t0).toFixed(0)} ms`)
console.log(`tx: ${result.public?.txId} @ block ${result.public?.blockHeight}`)

// The coin's three fields, printed because a caller may want them without a scan.
//
// ⚠️ They are **not** the only record: minting to a recipient whose encryption key the builder can
// resolve — which is the case whenever you mint to your own wallet, and whenever you mint to a full
// `mn_shield-addr` — attaches a ciphertext, and an ordinary scan finds the coin
// (`rust/tests/scan_finds_a_minted_coin.rs` proves it against this very transaction). Minting to a
// bare coin public key the builder cannot resolve is the case where these three fields are all there
// is, and `midnight-native`'s `walletInsertCoin` is what takes such a coin.
const coin = result.private?.result
const hex = (b: Uint8Array | undefined) => (b === undefined ? '(absent)' : Buffer.from(b).toString('hex'))
console.log(`\n=== the coin — record these, nothing else has them ===`)
console.log(`nonce: ${hex(coin?.nonce)}`)
console.log(`color: ${hex(coin?.color)}`)
console.log(`value: ${coin?.value}`)
console.log(`owner: ${recipientKey}`)

await saveDustState(wallet as never, dustStateFile)
await wallet.stop()
process.exit(0)
