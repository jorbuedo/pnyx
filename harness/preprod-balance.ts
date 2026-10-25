// Read-only balance check for the preprod deploy/sponsor wallet.
//
// Same wallet assembly as deploy-preprod.ts (no-op shielded sync + large dust batches, seed from
// .preprod-wallet.json, dust sync restored from .preprod-dust-state.gz) but it submits nothing:
// no faucet request, no dust registration, no deploy. Use it to decide whether a deploy can be
// paid for before starting one.
//
// It does refresh the dust snapshot on the way out — that file is a pure cache, and refreshing it
// is what makes the next run (or the deploy itself) start from a catch-up instead of a ~15-minute
// cold sync.
//
// Run: bun run preprod:balance
import {assembleWallet, nightRaw, saveDustState, waitForSections} from '@pnyx/chain-client/wallet'
import {readPreprodWallet} from './preprod-wallet.js'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {createDefaultTestLogger} from '@midnight-ntwrk/testkit-js'
import {NetworkId} from '@midnight-ntwrk/wallet-sdk'


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

// Never creates a wallet: a fresh seed here would report an empty balance that says nothing about
// the wallet the caller meant, after a ~15 min sync.
const {masterSeed: seed, dustStateFile, source} = await readPreprodWallet()

const logger = createDefaultTestLogger()
const wallet = await assembleWallet(logger, env, seed, {dustStateFile})
const unshieldedAddress = wallet.unshieldedKeystore.getBech32Address().asString()
console.log(`\n=== Preprod wallet ===\nseed from: ${source}\nunshielded address: ${unshieldedAddress}\n`)

await wallet.wallet.start(wallet.zswapSecretKeys, wallet.dustSecretKey)

const night = nightRaw()
const started = Date.now()
const state = await waitForSections(wallet, 45 * 60_000, (s) => {
  const d = s.dust.state.progress
  console.log(
    `sync: unshielded=${s.unshielded.progress?.isStrictlyComplete() === true} ` +
      `dust=${d.appliedIndex}/${d.highestRelevantWalletIndex} ` +
      `NIGHT=${s.unshielded.balances[night] ?? 0n} ` +
      `elapsed=${Math.round((Date.now() - started) / 1000)}s heapMB=${Math.round(process.memoryUsage().heapUsed / 1e6)}`,
  )
})

const nightBalance = state.unshielded.balances[night] ?? 0n
const dustBalance = state.dust.balance(new Date())
const nightCoins = state.unshielded.availableCoins.filter((coin) => coin.utxo.type === night)
const registered = nightCoins.filter((coin) => coin.meta.registeredForDustGeneration)
const unregistered = nightCoins.filter((coin) => !coin.meta.registeredForDustGeneration)

console.log(
  [
    '',
    '=== Balance ===',
    `NIGHT: ${nightBalance}`,
    `DUST:  ${dustBalance}`,
    `NIGHT UTXOs: ${nightCoins.length} (${registered.length} registered for dust generation, ${unregistered.length} not)`,
    '',
    // DUST is what pays fees; NIGHT alone cannot. Unregistered NIGHT means a deploy has to run the
    // registration first and then wait for dust to accrue (deploy-preprod.ts does both).
    dustBalance > 0n
      ? 'Can pay fees now.'
      : unregistered.length > 0
        ? 'No DUST yet, but NIGHT is present and unregistered — a deploy will register it and wait for dust.'
        : nightBalance > 0n
          ? 'NIGHT is registered but no DUST observed yet — generation may still be accruing.'
          : 'Empty: fund the address above (Midnight preprod faucet, chain-deploy skill §4) before deploying.',
    '',
  ].join('\n'),
)

await saveDustState(wallet as never, dustStateFile)
console.log(`Dust sync state snapshotted → ${dustStateFile}`)
await wallet.stop()
