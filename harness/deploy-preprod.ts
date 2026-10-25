// Preprod deploy of identity.compact — **one identity's** contract, since the global registry is gone
// (`docs/BOUNDED_STATE_ARCHITECTURE.md` §1). It deploys the shell for the seed in .preprod-wallet.json.
//
// ⚠️ There is no longer a single identity-contract address for the sponsor host or the content service
// to be configured with: an address is derived per `C`. Both still read one from
// `IDENTITY_CONTRACT_ADDRESS` / `chain.identityContractAddress`, which is an integration item, not
// something this script can supply.
// Wallet: the shared @pnyx/chain-client assembly (no-op shielded sync + large dust
// batches), a mnemonic persisted in .preprod-wallet.json (gitignored) so the same wallet
// is reused across sessions and can be opened in the app (harness/preprod-wallet.ts). The
// dust section's synced state is snapshotted per wallet (gitignored) — later runs restore
// it and only sync the catch-up.
// Funding: tries the faucet API (Turnstile-gated for browsers; the API sometimes accepts
// dummy tokens from CI). If that fails, prints the address for a manual faucet visit and exits.
// Proving: local proof server (see README). Run: node --import tsx harness/deploy-preprod.ts
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {assembleWallet, currentFacadeState, nightRaw, saveDustState, waitForSections} from '@pnyx/chain-client/wallet'
import {bytes32} from '@pnyx/contract-client/bytes'
import {identityCommitment} from '@pnyx/contract-client/derivations'
import {type IdentityPrivateState, createIdentityWitnesses} from '@pnyx/contract-client/identity-witnesses'
import {deployContract} from '@midnight-ntwrk/midnight-js-contracts'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {CompiledContract} from '@midnight-ntwrk/midnight-js-protocol/compact-js'
import {createDefaultTestLogger, FaucetClient, initializeMidnightProviders} from '@midnight-ntwrk/testkit-js'
import {NetworkId} from '@midnight-ntwrk/wallet-sdk'
import {Contract} from '../contract/managed/identity/contract/index.js'
import {createPreprodWallet, preprodWalletFile, readPreprodWallet} from './preprod-wallet.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const managedDir = path.resolve(here, '../contract/managed/identity')
const deployFile = path.resolve(here, '../.preprod-deploy.json')

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

const privateState: IdentityPrivateState = {identitySk: bytes32(7)}

const logger = createDefaultTestLogger()
// A mnemonic, always. A wallet minted from raw bytes can hold funds and deploy contracts and still
// never be opened in the app, which is how the old sponsor became un-inspectable from the product it
// sponsored (`docs/SPONSOR_HOST.md`).
const {masterSeed: seed, dustStateFile, unshieldedAddress, source} = fs.existsSync(preprodWalletFile)
  ? await readPreprodWallet()
  : await createPreprodWallet()

console.log(`\n=== Preprod deploy wallet ===\nseed from: ${source}\nunshielded address (faucet target): ${unshieldedAddress}\n`)
const wallet = await assembleWallet(logger, env, seed, {dustStateFile})

// Try the faucet API up-front (before the slow sync). It is Turnstile-gated and usually
// 403s for non-browser callers — treat that as "fund manually", not fatal.
try {
  await new FaucetClient(env.faucet, logger).requestTokens(unshieldedAddress)
  console.log('Faucet API accepted the drip request.')
} catch (error) {
  console.warn(
    `Faucet API rejected the request (${error instanceof Error ? error.message : String(error)}).\n` +
      `Fund manually if the wallet is empty: open https://faucet.preprod.midnight.network/ and paste\n  ${unshieldedAddress}\n`,
  )
}

// Deliberately NOT waiting for the shielded (zswap) section: it walks the chain's full
// note history (>30 min, multi-GB heap) and the deploy touches no shielded coins — fees
// are DUST, signing is the unshielded keystore. Only those two sections must be synced.
await wallet.wallet.start(wallet.zswapSecretKeys, wallet.dustSecretKey)

const night = nightRaw()
let state = await waitForSections(wallet, 60 * 60_000, (s) => {
  const d = s.dust.state.progress
  console.log(
    `sync: unshielded=${s.unshielded.progress?.isStrictlyComplete() === true} dust=${d.appliedIndex}/${d.highestRelevantWalletIndex} NIGHT=${s.unshielded.balances[night] ?? 0n} heapMB=${Math.round(process.memoryUsage().heapUsed / 1e6)}`,
  )
})
await saveDustState(wallet as never, dustStateFile)
console.log(`Dust sync state snapshotted → ${dustStateFile}`)

// Poll for NIGHT so a manual faucet drip is picked up while this script waits.
const fundingDeadline = Date.now() + 60 * 60_000
while ((state.unshielded.balances[night] ?? 0n) === 0n) {
  if (Date.now() > fundingDeadline) {
    console.error(`\nNo NIGHT after 60 min. Fund via https://faucet.preprod.midnight.network/ → ${unshieldedAddress}\n`)
    await wallet.stop()
    process.exit(2)
  }
  console.log(`Waiting for NIGHT… fund ${unshieldedAddress} at https://faucet.preprod.midnight.network/ (captcha)`)
  await new Promise((resolve) => setTimeout(resolve, 30_000))
  state = await currentFacadeState(wallet)
}
console.log(`NIGHT balance: ${state.unshielded.balances[night]}`)

// Register NIGHT UTXOs for DUST generation (fees), then wait for dust to accrue.
const unregistered = state.unshielded.availableCoins.filter(
  (coin) => coin.utxo.type === night && coin.meta.registeredForDustGeneration === false,
)
if (unregistered.length > 0) {
  // The registration pays its own fee from the dust its NIGHT projects to generate;
  // submitting before the projection covers the fee fails the SDK's fee-coverage guard.
  // testkit nests wallet-sdk 1.1.0, so `wallet.wallet` is *typed* as that older facade — which has
  // no dust-generation methods. `assembleWallet` deliberately builds the TOP-LEVEL 1.2.x facade, so
  // they exist at runtime; the mismatch is nominal only (chain-deploy §8).
  const dustGen = wallet.wallet as unknown as {
    estimateRegistration(utxos: readonly unknown[]): Promise<{fee: bigint}>
    waitForGeneratedDust(utxos: readonly unknown[], fee: bigint, opts: {timeoutMs: number}): Promise<void>
    registerNightUtxosForDustGeneration(
      utxos: readonly unknown[],
      publicKey: ReturnType<typeof wallet.unshieldedKeystore.getPublicKey>,
      sign: (payload: Uint8Array) => unknown,
      // Returned recipe stays precisely typed, so `finalizeRecipe` below is still checked.
    ): Promise<Parameters<typeof wallet.wallet.finalizeRecipe>[0]>
  }
  const {fee} = await dustGen.estimateRegistration(unregistered)
  console.log(`Waiting for projected dust on ${unregistered.length} NIGHT UTXO(s) to cover the registration fee (${fee})…`)
  await dustGen.waitForGeneratedDust(unregistered, fee, {timeoutMs: 30 * 60_000})
  console.log(`Registering ${unregistered.length} NIGHT UTXO(s) for dust generation…`)
  const recipe = await dustGen.registerNightUtxosForDustGeneration(
    unregistered,
    wallet.unshieldedKeystore.getPublicKey(),
    (payload: Uint8Array) => wallet.unshieldedKeystore.signData(payload),
  )
  const finalized = await wallet.wallet.finalizeRecipe(recipe)
  const txId = await wallet.wallet.submitTransaction(finalized)
  console.log(`Dust registration tx: ${txId}`)
}
while (state.dust.balance(new Date()) === 0n) {
  console.log('Waiting for DUST to generate from registered NIGHT…')
  await new Promise((resolve) => setTimeout(resolve, 30_000))
  state = await currentFacadeState(wallet)
}
console.log(`DUST balance: ${state.dust.balance(new Date())}`)
await saveDustState(wallet as never, dustStateFile)

const compiledContract = CompiledContract.make('PnyxIdentity', Contract).pipe(
  CompiledContract.withWitnesses(createIdentityWitnesses()),
  CompiledContract.withCompiledFileAssets(managedDir),
)

const providers = initializeMidnightProviders(wallet, env, {
  zkConfigPath: managedDir,
  privateStateStoreName: 'pnyx-preprod-private-state',
})

// DUST accrues gradually after registration — retry while the balance grows into the fee.
const attemptDeploy = async (attempt: number): Promise<Awaited<ReturnType<typeof deployContract>>> => {
  console.log(`Deploying identity.compact to Preprod (attempt ${attempt})…`)
  try {
    return await deployContract(
      providers as never,
      {
        compiledContract,
        privateStateId: 'pnyxSpikePreprod',
        initialPrivateState: privateState,
        args: [identityCommitment(privateState.identitySk)],
      } as never,
    )
  } catch (error) {
    const text = error instanceof Error ? `${error.message}` : String(error)
    if (attempt < 15 && /dust|fee|insufficient|balance/i.test(text)) {
      console.log(`Deploy attempt failed (${text.slice(0, 200)}); waiting 60s for more DUST…`)
      await new Promise((resolve) => setTimeout(resolve, 60_000))
      return attemptDeploy(attempt + 1)
    }
    throw error
  }
}
const deployed = await attemptDeploy(1)

const {contractAddress, blockHeight, txId} = deployed.deployTxData.public
console.log(`\n=== Deployed ===\ncontract address: ${contractAddress}\ntx: ${txId} @ block ${blockHeight}\n`)
fs.writeFileSync(
  deployFile,
  `${JSON.stringify({network: 'preprod', contractAddress, txId, blockHeight: String(blockHeight), deployedAt: new Date().toISOString()}, null, 2)}\n`,
)
console.log(`Recorded → ${deployFile}`)
await saveDustState(wallet as never, dustStateFile)
await wallet.stop()
process.exit(0)
