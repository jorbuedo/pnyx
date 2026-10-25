// Mint a claim permit on preprod, so a handle can actually be bound.
//
// Run after `preprod:deploy-payment`:
//   PREPROD_MNEMONIC="abandon … about" node --import tsx harness/grant-permit-preprod.ts [name]
//
// `grantPermit` needs **no price row**, which is the whole reason it exists: it exercises the handle
// path end to end without settling which currency launches (§3.3). It is gated on `adminAuth`, whose
// preimage is the grant secret written by the deploy script.
//
// ⚠️ The permit is minted to a **recipient we name**, and that is only sound because it is
// **unshielded**. A shielded grant would need the recipient's encryption key out of band, so it could
// never find it — which is why the shielded design had to mint to the caller instead (§3.4.1).
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {findDeployedContract} from '@midnight-ntwrk/midnight-js-contracts'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {CompiledContract} from '@midnight-ntwrk/midnight-js-protocol/compact-js'
import {createDefaultTestLogger, initializeMidnightProviders} from '@midnight-ntwrk/testkit-js'
import {NetworkId} from '@midnight-ntwrk/wallet-sdk'
import {assembleWallet, currentFacadeState, saveDustState, waitForSections} from '@pnyx/chain-client/wallet'
import {permitDomain} from '@pnyx/contract-client/derivations'
import {encodeHandle, handleTier, validateHandle} from '@pnyx/contract-client/handle'
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

if (!fs.existsSync(paymentFile)) {
  console.error(`No ${paymentFile}. Run \`bun run preprod:deploy-payment\` first.`)
  process.exit(2)
}
const payment = JSON.parse(fs.readFileSync(paymentFile, 'utf8')) as {
  contractAddress: string
  grantSecret: string
  adminAuth: string
}

// Which name this permit is for. The permit is per **tier**, not per name — so it will bind any name
// of the same byte length bucket, which is what makes a race loser's permit still useful (§3.4).
const requested = process.argv[2] ?? 'test'
const checked = validateHandle(requested)
if (!checked.ok) {
  console.error(`"${requested}" is not a valid handle: ${checked.reason}`)
  process.exit(2)
}
const tier = handleTier(encodeHandle(checked.handle))
console.log(`\n=== grantPermit ===\nname: ${checked.handle} (tier ${tier})`)
console.log(`permit domain: ${Buffer.from(permitDomain(tier)).toString('hex')}`)

const logger = createDefaultTestLogger()
const {masterSeed: seed, dustStateFile, unshieldedAddress} = await readPreprodWallet()
const parsed = parseMidnightAddress(unshieldedAddress)
if (!parsed.ok || parsed.kind !== 'night') throw new Error(`bad night address: ${unshieldedAddress}`)
console.log(`recipient (this wallet): ${unshieldedAddress}`)

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
  // Unused here — only `rotateAdmin` reads it, and this script does not rotate. Deliberately not the
  // live secret, so a copy-paste into a rotation cannot install the secret it is meant to replace.
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
const deployed = await findDeployedContract(
  providers as never,
  {
    compiledContract,
    contractAddress: payment.contractAddress,
    privateStateId: 'pnyxPaymentPreprod',
    initialPrivateState: privateState,
  } as never,
)

type CallTx = Readonly<{grantPermit: (tier: unknown, recipient: unknown) => Promise<unknown>}>
const callTx = (deployed as unknown as {callTx: CallTx}).callTx

console.log(`Minting a tier-${tier} permit (real proof, real block)…`)
const t0 = performance.now()
const result = (await callTx.grantPermit(BigInt(tier), userRecipient(parsed.payload))) as {
  public?: {txId?: string; blockHeight?: bigint}
}
console.log(`granted in ${(performance.now() - t0).toFixed(0)} ms`)
console.log(`tx: ${result.public?.txId} @ block ${result.public?.blockHeight}`)

await saveDustState(wallet as never, dustStateFile)
await wallet.stop()
process.exit(0)
