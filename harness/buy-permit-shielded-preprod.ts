// Buy a handle permit on preprod with a **shielded** token — the one circuit in the repo that
// reaches Zswap.
//
// Run, with the coin `preprod:mint-token` printed:
//   PREPROD_MNEMONIC="abandon … about" node --import tsx harness/buy-permit-shielded-preprod.ts \
//     <tier> <nonceHex> <colourHex> <value>
//
// ⚠️ **The coin is passed in because the circuit takes it as an argument** — `buyPermitShielded`
// names the coin it is paying with. It is not passed in because it is unfindable: a coin minted to
// this wallet carries a ciphertext and an ordinary scan claims it
// (`rust/tests/scan_finds_a_minted_coin.rs`).
//
// ⚠️ **This purchase can never be sponsored.** A shielded offer's colours, amounts and recipients
// are exactly what shielding hides, so the sponsor cannot check them against what the circuit
// declared and refuses the whole shape (`SPONSORED_PAYMENT_ENTRY_POINTS` omits `buyPermitShielded`
// deliberately). The buyer pays their own DUST, which this wallet has.
//
// ⚠️⚠️ **This script does not work yet.** It fails at `balanceTransaction` with
// `Wallet.InsufficientFunds { tokenType: <the colour>, amount: -<value> }` — measured on preprod
// against a coin that provably exists on chain and that a scan **can** claim.
//
// The cause is `assembleWallet`'s deliberate **no-op shielded sync**: this wallet never scans, so it
// never sees the coin it would be perfectly able to spend. (That sync exists because preprod's zswap
// history is unbounded and a real one OOMs — see the chain-deploy notes.) An earlier version of this
// comment blamed the SDK instead and was wrong.
//
// So there are two ways forward, and neither is blocked by the other: give this harness a shielded
// section that actually syncs, or finish the device rail, which needs a Zswap offer built **beside a
// contract call** — `docs/SHIELDED_CAPABILITIES.md` §3.2. Kept in the tree because everything up to
// the funding step is correct.
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {findDeployedContract} from '@midnight-ntwrk/midnight-js-contracts'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {CompiledContract} from '@midnight-ntwrk/midnight-js-protocol/compact-js'
import {createDefaultTestLogger, initializeMidnightProviders} from '@midnight-ntwrk/testkit-js'
import {NetworkId} from '@midnight-ntwrk/wallet-sdk'
import {assembleWallet, currentFacadeState, saveDustState, waitForSections} from '@pnyx/chain-client/wallet'
import {permitPriceKey} from '@pnyx/contract-client/derivations'
import {userRecipient} from '@pnyx/contract-client/payment-simulator'
import {createPaymentWitnesses, type PaymentPrivateState} from '@pnyx/contract-client/payment-witnesses'
import {parseMidnightAddress} from '../packages/wallet/account/derivation/midnight-address-encoding.js'
import {Contract} from '../contract/managed/payment/contract/index.js'
import {readPreprodWallet} from './preprod-wallet.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const managedDir = path.resolve(here, '../contract/managed/payment')
const paymentFile = path.resolve(here, '../.preprod-payment.json')

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

const usage = () => {
  console.error('usage: buy-permit-shielded-preprod.ts <tier 0..6> <nonceHex> <colourHex> <value>')
  process.exit(2)
}
const [tierArg, nonceArg, colourArg, valueArg] = process.argv.slice(2)
const tier = Number(tierArg)
if (!Number.isInteger(tier) || tier < 0 || tier > 6) usage()
if (!/^[0-9a-f]{64}$/i.test(nonceArg ?? '') || !/^[0-9a-f]{64}$/i.test(colourArg ?? '')) usage()
const value = BigInt(valueArg ?? usage())

const bytes = (h: string) => Uint8Array.from(Buffer.from(h.toLowerCase(), 'hex'))
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

if (!fs.existsSync(paymentFile)) {
  console.error(`No ${paymentFile}. Run \`bun run preprod:deploy-payment\` first.`)
  process.exit(2)
}
const payment = JSON.parse(fs.readFileSync(paymentFile, 'utf8')) as {contractAddress: string; grantSecret: string}

const colour = bytes(colourArg as string)
console.log('\n=== buyPermitShielded ===')
console.log(`contract:  ${payment.contractAddress}`)
console.log(`tier:      ${tier}`)
console.log(`coin:      ${value} of ${hex(colour)}`)
console.log(`nonce:     ${nonceArg}`)
console.log(`price key: ${hex(permitPriceKey(tier, colour))}`)

const logger = createDefaultTestLogger()
const {masterSeed: seed, dustStateFile, unshieldedAddress} = await readPreprodWallet()
const parsed = parseMidnightAddress(unshieldedAddress)
if (!parsed.ok || parsed.kind !== 'night') throw new Error(`bad night address: ${unshieldedAddress}`)
console.log(`permit to: ${unshieldedAddress}`)

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

// ⚠️ `nextAdminSecret` is never read here — only `rotateAdmin` reads it — and is deliberately not
// the live secret, so a copy-paste into a rotation cannot install the secret it means to replace.
// `grantSecret` is not read either: `buyPermitShielded` is not admin-gated. Both are present because
// the witness set is per-contract, not per-circuit.
const privateState: PaymentPrivateState = {
  grantSecret: bytes(payment.grantSecret),
  nextAdminSecret: new Uint8Array(32).fill(0xff),
}
const compiledContract = CompiledContract.make('PnyxPayment', Contract).pipe(
  CompiledContract.withWitnesses(createPaymentWitnesses()),
  CompiledContract.withCompiledFileAssets(managedDir),
)
const providers = initializeMidnightProviders(wallet, env, {
  zkConfigPath: managedDir,
  privateStateStoreName: 'pnyx-preprod-payment-state',
})

console.log(`\nBinding to ${payment.contractAddress}…`)
const deployed = await findDeployedContract(providers as never, {
  compiledContract,
  contractAddress: payment.contractAddress,
  privateStateId: 'pnyxPaymentPreprod',
  initialPrivateState: privateState,
} as never)

type CallTx = Readonly<{
  buyPermitShielded: (tier: bigint, coin: unknown, recipient: unknown) => Promise<unknown>
}>
const callTx = (deployed as unknown as {callTx: CallTx}).callTx

console.log('Buying (real proof, real block)…')
const t0 = performance.now()
const result = (await callTx.buyPermitShielded(
  BigInt(tier),
  {nonce: bytes(nonceArg as string), color: colour, value},
  // The **permit** is unshielded, so its recipient is the other rail's `Either` — left is the
  // contract here, right is the user. Not interchangeable with the coin recipient above.
  userRecipient(parsed.payload),
)) as {public?: {txId?: string; blockHeight?: bigint}}
console.log(`bought in ${(performance.now() - t0).toFixed(0)} ms`)
console.log(`tx: ${result.public?.txId} @ block ${result.public?.blockHeight}`)

await saveDustState(wallet as never, dustStateFile)
await wallet.stop()
process.exit(0)
