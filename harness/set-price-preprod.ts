// Open or close a handle tier's price row on preprod — the lever that decides what a name costs.
//
// Run after `preprod:deploy-payment`:
//   PREPROD_MNEMONIC="abandon … about" node --import tsx harness/set-price-preprod.ts free 6
//   PREPROD_MNEMONIC="abandon … about" node --import tsx harness/set-price-preprod.ts night 5 1
//   PREPROD_MNEMONIC="abandon … about" node --import tsx harness/set-price-preprod.ts close 6
//
// **Which currencies are accepted, and at what price, is state rather than code** — that is what
// `setPrice` exists for, and it is why the launch currency is a decision nobody had to take when the
// contract was written (§3.3). Three currencies matter here:
//
//   `free`   the reserved colour `pnyx:free`. A row under it makes the tier claimable by anyone for
//            nothing through `claimFreePermit`; ⚠️ the **amount is never read**, only the row's
//            presence, so the 1 below is a placeholder and not a price.
//   `night`  the native token, colour = 32 zero bytes. A real payment, so the caller must hold it.
//   `close`  a price of zero, which **removes** the row — the same lever that stops accepting a
//            currency ends a giveaway. It is not "free"; `buyPermitUnshielded` asserts the row exists.
//
// Gated on `adminAuth`, whose preimage is the grant secret the deploy script wrote.
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {findDeployedContract} from '@midnight-ntwrk/midnight-js-contracts'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {CompiledContract} from '@midnight-ntwrk/midnight-js-protocol/compact-js'
import {createDefaultTestLogger, initializeMidnightProviders} from '@midnight-ntwrk/testkit-js'
import {NetworkId} from '@midnight-ntwrk/wallet-sdk'
import {assembleWallet, currentFacadeState, saveDustState, waitForSections} from '@pnyx/chain-client/wallet'
import {FREE_COLOR, permitPriceKey} from '@pnyx/contract-client/derivations'
import {createPaymentWitnesses, type PaymentPrivateState} from '@pnyx/contract-client/payment-witnesses'
import {Contract} from '../contract/managed/payment/contract/index.js'
import {deviceProofProvider} from './device-proof-provider.js'
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

/** The native token's colour. Not a constant we chose — NIGHT is token type zero. */
const NIGHT_COLOR = new Uint8Array(32)

const usage = () => {
  console.error('usage: set-price-preprod.ts <free|night|close> <tier 0..6> [amount, night only]')
  console.error('       set-price-preprod.ts token <tier 0..6> <colourHex> <amount>')
  process.exit(2)
}

const [kind, tierArg, thirdArg, fourthArg] = process.argv.slice(2)
if (kind !== 'free' && kind !== 'night' && kind !== 'close' && kind !== 'token') usage()
const tier = Number(tierArg)
if (!Number.isInteger(tier) || tier < 0 || tier > 6) usage()

// `token` prices an arbitrary colour — any contract-minted token, shielded or unshielded. It is how
// the shielded rail gets priced at all: a shielded colour is `tokenType(domainSep, minter)`, so it
// is never a constant this script could carry.
if (kind === 'token' && !/^[0-9a-f]{64}$/i.test(thirdArg ?? '')) usage()
const color =
  kind === 'token'
    ? Uint8Array.from(Buffer.from((thirdArg as string).toLowerCase(), 'hex'))
    : kind === 'night'
      ? NIGHT_COLOR
      : FREE_COLOR
// A giveaway's amount is unread, so it is 1 rather than 0 — zero is what *removes* a row.
const amount =
  kind === 'close' ? 0n : kind === 'free' ? 1n : kind === 'token' ? BigInt(fourthArg ?? '1') : BigInt(thirdArg ?? '1')

if (!fs.existsSync(paymentFile)) {
  console.error(`No ${paymentFile}. Run \`bun run preprod:deploy-payment\` first.`)
  process.exit(2)
}
const payment = JSON.parse(fs.readFileSync(paymentFile, 'utf8')) as {
  contractAddress: string
  grantSecret: string
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
console.log(`\n=== setPrice ===`)
console.log(`contract: ${payment.contractAddress}`)
console.log(`tier ${tier}, ${kind}${kind === 'night' || kind === 'token' ? ` (${amount} atomic units)` : ''}`)
console.log(`colour:   ${hex(color)}`)
// Printed because a client reads the row under exactly this key: if the two disagree the UI reports a
// tier as unavailable while the chain accepts it.
console.log(`price key: ${hex(permitPriceKey(tier, color))}`)

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

const privateState: PaymentPrivateState = {
  grantSecret: Uint8Array.from(Buffer.from(payment.grantSecret, 'hex')),
  // Unread here: only `rotateAdmin` takes it, and a wrong value must never be able to install itself.
  nextAdminSecret: new Uint8Array(32).fill(0xff),
}
const compiledContract = CompiledContract.make('PnyxPayment', Contract).pipe(
  CompiledContract.withWitnesses(createPaymentWitnesses()),
  CompiledContract.withCompiledFileAssets(managedDir),
)
const baseProviders = initializeMidnightProviders(wallet, env, {
  zkConfigPath: managedDir,
  privateStateStoreName: 'pnyx-preprod-payment-state',
})

// Prove on the phone rather than a proof server, when one is paired. The wallet serves the same
// circuit-level proving provider a dApp page reaches, and midnight-js's own proof provider is a thin
// adapter over that interface — so this swaps the prover and nothing else.
const mcpUrl = process.env.PNYX_MCP_URL
const mcpToken = process.env.PNYX_MCP_TOKEN
if (mcpUrl !== undefined && mcpToken === undefined) {
  console.error('PNYX_MCP_URL is set but PNYX_MCP_TOKEN is not — the wallet would refuse every call')
  process.exit(2)
}
console.log(`proving on: ${mcpUrl === undefined ? `proof server ${env.proofServer}` : `the paired wallet at ${mcpUrl}`}`)
const providers =
  mcpUrl === undefined || mcpToken === undefined
    ? baseProviders
    : {
        ...baseProviders,
        proofProvider: deviceProofProvider({
          url: mcpUrl,
          authorization: mcpToken.startsWith('Bearer ') ? mcpToken : `Bearer ${mcpToken}`,
          zkConfigProvider: baseProviders.zkConfigProvider,
        }),
      }

const deployed = await findDeployedContract(
  providers as never,
  {
    compiledContract,
    contractAddress: payment.contractAddress,
    privateStateId: 'pnyxPaymentPreprod',
    initialPrivateState: privateState,
  } as never,
)

type CallTx = Readonly<{setPrice: (tier: unknown, color: unknown, price: unknown) => Promise<unknown>}>
const callTx = (deployed as unknown as {callTx: CallTx}).callTx

const t0 = performance.now()
const result = (await callTx.setPrice(BigInt(tier), color, amount)) as {
  public?: {txId?: string; blockHeight?: bigint}
}
console.log(`\nset in ${(performance.now() - t0).toFixed(0)} ms`)
console.log(`tx: ${result.public?.txId} @ block ${result.public?.blockHeight}`)

await saveDustState(wallet as never, dustStateFile)
await wallet.stop()
process.exit(0)
