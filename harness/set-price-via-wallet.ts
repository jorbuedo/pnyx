// Open or close a handle tier's price row on preprod — composed here, done entirely by the phone.
//
//   PNYX_MCP_URL=… PNYX_MCP_TOKEN=… node --import tsx harness/set-price-via-wallet.ts close 4
//   PNYX_MCP_URL=… PNYX_MCP_TOKEN=… node --import tsx harness/set-price-via-wallet.ts free 4
//   PNYX_MCP_URL=… PNYX_MCP_TOKEN=… node --import tsx harness/set-price-via-wallet.ts night 5 1
//
// The difference from `./set-price-preprod.ts` is where the work happens, not what it does. That one
// assembles a Node wallet and uses it to pay and broadcast: same key as the phone, different process,
// which is not the phone doing it. This one assembles **no wallet at all** — every provider that needs
// one points at the paired app instead:
//
//   proving      → the device's native prover      (`./device-proof-provider.ts`)
//   fee + review → the device's own DUST, approved by a person   (`./wallet-mcp-providers.ts`)
//   submission   → the device's submission rail                  (`./wallet-mcp-providers.ts`)
//
// So this script holds no seed, spends nothing, and cannot send anything a person did not approve on
// the phone. What it still owns is *composition*: the contract, its witnesses, and the grant secret
// that authorises the call. That is the dApp's half, and it is meant to be here.
//
// ⚠️ **It blocks on a human.** The fee/review step returns when somebody approves or rejects on the
// wallet's funding screen. A long wait here is a phone nobody has picked up.
//
// **What the three modes mean** — unchanged from the older script, because the contract is unchanged:
//   `free`   a row under the reserved colour `pnyx:free` makes the tier claimable by anyone through
//            `claimFreePermit`; ⚠️ the **amount is never read**, only the row's presence.
//   `night`  the native token, colour = 32 zero bytes. A real payment.
//   `close`  a price of zero, which **removes** the row — the lever that ends a giveaway. It is not
//            "free": `buyPermitUnshielded` asserts the row exists.
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {findDeployedContract} from '@midnight-ntwrk/midnight-js-contracts'
import {indexerPublicDataProvider} from '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
import {levelPrivateStateProvider} from '@midnight-ntwrk/midnight-js-level-private-state-provider'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {NodeZkConfigProvider} from '@midnight-ntwrk/midnight-js-node-zk-config-provider'
import {CompiledContract} from '@midnight-ntwrk/midnight-js-protocol/compact-js'
import {FREE_COLOR, permitPriceKey} from '@pnyx/contract-client/derivations'
import {createPaymentWitnesses, type PaymentPrivateState} from '@pnyx/contract-client/payment-witnesses'
import {Contract} from '../contract/managed/payment/contract/index.js'
import {deviceProofProvider} from './device-proof-provider.js'
import {walletMcpProviders} from './wallet-mcp-providers.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const managedDir = path.resolve(here, '../contract/managed/payment')
const paymentFile = path.resolve(here, '../.preprod-payment.json')

const env = {
  networkId: 'preprod',
  indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
  indexerWS: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
}
setNetworkId(env.networkId)

/** The native token's colour. Not a constant we chose — NIGHT is token type zero. */
const NIGHT_COLOR = new Uint8Array(32)

const usage = () => {
  console.error('usage: set-price-via-wallet.ts <free|night|close> <tier 0..6> [amount, night only]')
  console.error('needs PNYX_MCP_URL and PNYX_MCP_TOKEN for a paired, *serving* wallet')
  process.exit(2)
}

const [kind, tierArg, amountArg] = process.argv.slice(2)
if (kind !== 'free' && kind !== 'night' && kind !== 'close') usage()
const tier = Number(tierArg)
if (!Number.isInteger(tier) || tier < 0 || tier > 6) usage()

const mcpUrl = process.env.PNYX_MCP_URL
const rawToken = process.env.PNYX_MCP_TOKEN
if (mcpUrl === undefined || rawToken === undefined) usage()
const authorization = rawToken.startsWith('Bearer ') ? rawToken : `Bearer ${rawToken}`

const color = kind === 'night' ? NIGHT_COLOR : FREE_COLOR
// A giveaway's amount is unread, so it is 1 rather than 0 — zero is what *removes* a row.
const amount = kind === 'close' ? 0n : kind === 'free' ? 1n : BigInt(amountArg ?? '1')

if (!fs.existsSync(paymentFile)) {
  console.error(`No ${paymentFile}. Run \`bun run preprod:deploy-payment\` first.`)
  process.exit(2)
}
const payment = JSON.parse(fs.readFileSync(paymentFile, 'utf8')) as {
  contractAddress: string
  grantSecret: string
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
console.log('\n=== setPrice, through the wallet ===')
console.log(`contract: ${payment.contractAddress}`)
console.log(`tier ${tier}, ${kind}${kind === 'night' ? ` (${amount} atomic units)` : ''}`)
console.log(`colour:   ${hex(color)}`)
// Printed because a client reads the row under exactly this key: if the two disagree the UI reports a
// tier as unavailable while the chain accepts it.
console.log(`price key: ${hex(permitPriceKey(tier, color))}`)

const privateState: PaymentPrivateState = {
  grantSecret: Uint8Array.from(Buffer.from(payment.grantSecret, 'hex')),
  // Unread here: only `rotateAdmin` takes it, and a wrong value must never be able to install itself.
  nextAdminSecret: new Uint8Array(32).fill(0xff),
}

const compiledContract = CompiledContract.make('PnyxPayment', Contract).pipe(
  CompiledContract.withWitnesses(createPaymentWitnesses()),
  CompiledContract.withCompiledFileAssets(managedDir),
)

console.log(`\nwallet: ${mcpUrl}`)
const wallet = await walletMcpProviders({url: mcpUrl, authorization})
const zkConfigProvider = new NodeZkConfigProvider(managedDir)

// Assembled by hand rather than through testkit's `initializeMidnightProviders`, which takes a Node
// wallet and uses it for three of the six providers. The other three are wallet-free and are exactly
// what this needs; the wallet-shaped ones come from the phone.
const providers = {
  privateStateProvider: levelPrivateStateProvider({
    privateStateStoreName: 'pnyx-preprod-payment-state-via-wallet',
    signingKeyStoreName: 'pnyx-preprod-payment-state-via-wallet-signing-keys',
    privateStoragePasswordProvider: () => 'Answer to the Ultimate Question of Life, the Universe, and Everything!',
    accountId: Buffer.from(wallet.walletProvider.getCoinPublicKey()).toString('hex'),
  }),
  publicDataProvider: indexerPublicDataProvider(env.indexer, env.indexerWS),
  zkConfigProvider,
  proofProvider: deviceProofProvider({url: mcpUrl, authorization, zkConfigProvider}),
  walletProvider: wallet.walletProvider,
  midnightProvider: wallet.midnightProvider,
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

console.log('\ncomposing, then the phone proves, pays and sends…')
const t0 = performance.now()
const result = (await callTx.setPrice(BigInt(tier), color, amount)) as {
  public?: {txId?: string; blockHeight?: bigint}
}
console.log(`\ndone in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
const balance = wallet.lastBalance()
console.log(`fee paid by: ${balance === null ? 'unknown' : balance.bound ? 'the phone’s own DUST' : 'the sponsor'}`)
console.log(`tx: ${result.public?.txId} @ block ${result.public?.blockHeight}`)
process.exit(0)
