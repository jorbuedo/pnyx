// An unshielded NIGHT transfer on preprod — the send itself, and the question of who pays for it.
//
// Two modes, because they answer different questions:
//
//   --self-pay   build, sign, balance with our OWN dust, submit. Proves the transfer rail.
//   --sponsor    build with `payFees: false`, sign, finalize, and print the bytes a sponsor would be
//                asked to balance. Nothing is submitted; `--post` hands them to the sponsor host.
//
// The second mode is the one that matters for the device. A phone cannot hold DUST it has not synced,
// and the dust sync is the expensive part (>1.2M events on preprod) — but fees are attached by a
// *separate* balancing transaction that is merged with ours, and an unshielded signature covers only
// its own intent (`Intent.signatureData(segmentId)`). So a third party can pay for a transfer it did
// not author, and `transferTransaction`'s own `payFees` flag exists for exactly that.
//
// What this cannot do is make the sponsor *willing*: the policy funds one contract action and refuses
// anything that moves value (`@pnyx/chain-client/sponsorship`). `--post` reports that refusal verbatim,
// which is the honest answer to "is this possible today".
//
// Run: bun run preprod:send -- --to mn_addr_preprod1… --night 1 --self-pay
import {nightRaw, assembleWallet, saveDustState, waitForSections} from '@pnyx/chain-client/wallet'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {createDefaultTestLogger} from '@midnight-ntwrk/testkit-js'
import {NetworkId} from '@midnight-ntwrk/wallet-sdk'
import {UnshieldedAddress} from '@midnight-ntwrk/wallet-sdk-address-format'
import {makeWasmProvingService} from '@midnight-ntwrk/wallet-sdk-capabilities/proving'
import {parseMidnightAddress} from '../packages/wallet/account/derivation/midnight-address-encoding.js'
import {readPreprodWallet} from './preprod-wallet.js'

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`)

const to = arg('to')
const nightArg = arg('night')
const selfPay = flag('self-pay')
const sponsor = flag('sponsor')

if (to === undefined || nightArg === undefined || selfPay === sponsor) {
  console.error(
    'Usage: bun run preprod:send -- --to <mn_addr_preprod1…> --night <amount> (--self-pay | --sponsor [--post])',
  )
  process.exit(2)
}
// Parsed rather than pattern-matched: the builder wants the 32-byte payload, and the checksum is the
// only thing that distinguishes a mistyped address from a real one.
const recipient = parseMidnightAddress(to)
if (!recipient.ok || recipient.kind !== 'night') {
  console.error(`--to must be an unshielded address (mn_addr…); this one is ${recipient.ok ? recipient.kind : recipient.reason}`)
  process.exit(2)
}
if (recipient.network !== 'preprod') {
  console.error(`--to is a ${recipient.network} address; this script only sends on preprod`)
  process.exit(2)
}
// NIGHT carries 6 decimals: the wallet's 6000000000 raw units read as 6,000 NIGHT in the app.
const NIGHT_DECIMALS = 6n
const amount = (() => {
  if (!/^\d+(\.\d{1,6})?$/.test(nightArg)) {
    console.error(`--night must be a decimal amount with at most 6 places, got ${nightArg}`)
    process.exit(2)
  }
  const [whole = '0', frac = ''] = nightArg.split('.')
  return BigInt(whole) * 10n ** NIGHT_DECIMALS + BigInt(frac.padEnd(Number(NIGHT_DECIMALS), '0') || '0')
})()

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

const {masterSeed, dustStateFile, unshieldedAddress, source} = await readPreprodWallet()
const logger = createDefaultTestLogger()
const wallet = await assembleWallet(logger, env, masterSeed, {dustStateFile})
console.log(`\n=== Unshielded send ===\nfrom: ${unshieldedAddress}\nseed: ${source}\nto:   ${to}\namount: ${amount} raw NIGHT\n`)

await wallet.wallet.start(wallet.zswapSecretKeys, wallet.dustSecretKey)
const night = nightRaw()
const state = await waitForSections(wallet, 45 * 60_000, (s) => {
  const d = s.dust.state.progress
  console.log(`sync: dust=${d.appliedIndex}/${d.highestRelevantWalletIndex} NIGHT=${s.unshielded.balances[night] ?? 0n}`)
})
await saveDustState(wallet as never, dustStateFile)

const balance = state.unshielded.balances[night] ?? 0n
if (balance < amount) {
  console.error(`Wallet holds ${balance} raw NIGHT, less than the ${amount} requested.`)
  await wallet.stop()
  process.exit(2)
}

// testkit nests an older wallet-sdk, so `wallet.wallet` is *typed* as a facade without these methods
// while being the 1.2.x facade at runtime — the same nominal mismatch deploy-preprod.ts documents.
const facade = wallet.wallet as unknown as {
  transferTransaction(
    outputs: readonly unknown[],
    secretKeys: {shieldedSecretKeys: unknown; dustSecretKey: unknown},
    options: {ttl: Date; payFees?: boolean},
  ): Promise<{transaction: unknown}>
  signUnprovenTransaction(tx: unknown, signSegment: (data: Uint8Array) => unknown): Promise<unknown>
  signUnboundTransaction(tx: unknown, signSegment: (data: Uint8Array) => unknown): Promise<{serialize(): Uint8Array}>
  balanceUnprovenTransaction(tx: unknown, secretKeys: {shieldedSecretKeys: unknown; dustSecretKey: unknown}): Promise<unknown>
  finalizeRecipe(recipe: unknown): Promise<unknown>
  submitTransaction(tx: unknown): Promise<string>
}

const ttl = new Date(Date.now() + 30 * 60_000)
const outputs = [
  {
    type: 'unshielded',
    outputs: [{type: night, receiverAddress: new UnshieldedAddress(Buffer.from(recipient.payload)), amount}],
  },
]
const secretKeys = {shieldedSecretKeys: wallet.zswapSecretKeys, dustSecretKey: wallet.dustSecretKey}

// `payFees: false` is the sponsored shape: no dust spend of ours, so the fee is left for whoever
// balances it. With self-pay the SDK attaches our own dust and the transaction is complete.
const recipe = await facade.transferTransaction(outputs, secretKeys, {ttl, payFees: selfPay})

if (selfPay) {
  const signed = await facade.signUnprovenTransaction(recipe.transaction, (data) =>
    wallet.unshieldedKeystore.signData(data),
  )
  const balanced = await facade.balanceUnprovenTransaction(signed, secretKeys)
  const finalized = await facade.finalizeRecipe(balanced)
  const txId = await facade.submitTransaction(finalized)
  console.log(`\nSubmitted: ${txId}`)
} else {
  // Proven and **unbound** — `Transaction<SignatureEnabled, Proof, PreBinding>`, which is what a
  // sponsor can still merge a fee into. Binding is irreversible and covers the whole transaction, so
  // finalizing here would hand over bytes nobody can pay for (the sponsor answers exactly that:
  // "bytes are not a proven-unbound transaction").
  //
  // No key material and no proof server: a transfer carries no contract action and no shielded offer,
  // so there is nothing to prove — the step is a type transition, and that is the point for a phone.
  const unbound = await makeWasmProvingService().prove(recipe.transaction as never)
  const signed = await facade.signUnboundTransaction(unbound, (data) => wallet.unshieldedKeystore.signData(data))
  const bytes = signed.serialize()
  const b64 = Buffer.from(bytes).toString('base64')
  console.log(`\nUnbalanced transfer, finalized and signed: ${bytes.length} bytes`)
  console.log(`base64:\n${b64}\n`)
  if (flag('post')) {
    const origin = process.env.SPONSOR_ORIGIN ?? 'http://127.0.0.1:3400'
    const token = process.env.SPONSOR_TOKEN
    if (token === undefined || token === '') {
      console.error('--post needs SPONSOR_TOKEN (and SPONSOR_ORIGIN if not the loopback default)')
      await wallet.stop()
      process.exit(2)
    }
    // /internal/register is the synchronous route: it answers with the policy's own words, which is
    // the whole point of posting rather than reasoning about it.
    const response = await fetch(`${origin}/internal/register`, {
      method: 'POST',
      headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
      body: JSON.stringify({tx: b64}),
    })
    console.log(`sponsor answered ${response.status}: ${await response.text()}`)
  }
}

await wallet.stop()
