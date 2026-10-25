// Preprod deploy of `payment.compact` — the permit contract, deployed **once**, whose address is
// sealed into every handle template and can therefore never change.
//
// Run: PREPROD_MNEMONIC="abandon … about" node --import tsx harness/deploy-payment-preprod.ts
//
// ⚠️ **It does not matter which wallet deploys this.** Midnight has no `msg.sender`, the maintenance
// authority is the unsatisfiable default, and the address is a hash over the initial state — so the
// deployer gets no privilege and cannot influence the address. All the authority lives in constructor
// arguments: `adminAuth` (a hash of the grant secret written below) and the two treasuries.
//
// ⚠️ **The admin secret is generated here, by a CSPRNG, and cannot be supplied by the caller.** An
// earlier version of this script used `bytes32(0x5a)`, a fixture constant — and because `adminAuth` is
// a public hash on chain, that preimage was recovered offline in 3.8 ms after 91 guesses. The failure
// mode is always the entropy source, never the length: `bytes32(0x5a)` is 32 bytes too. So the script
// generates its own secret and `assertStrongSecret` refuses an obviously-weak one, rather than trusting
// whoever runs it.
//
// ⚠️ The secret is still written to `.preprod-payment.json` in the clear (mode 0600), because
// `preprod:grant-permit` and `preprod:claim-handle` need it. It is a **preprod** secret. A mainnet
// deploy must keep it off disk entirely.
//
// `adminAuth` is **mutable**, so a leak here is recoverable: `rotateAdmin` installs a new commitment
// on the current admin's authority. That is the whole reason the field is not sealed.
import {randomBytes} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {deployContract} from '@midnight-ntwrk/midnight-js-contracts'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {CompiledContract} from '@midnight-ntwrk/midnight-js-protocol/compact-js'
import {createDefaultTestLogger, initializeMidnightProviders} from '@midnight-ntwrk/testkit-js'
import {NetworkId} from '@midnight-ntwrk/wallet-sdk'
import {assembleWallet, currentFacadeState, nightRaw, saveDustState, waitForSections} from '@pnyx/chain-client/wallet'
import {pad32, persistentHash32} from '@pnyx/contract-client/derivations'
import {coinPublicKeyRecipient, userRecipient} from '@pnyx/contract-client/payment-simulator'
import {createPaymentWitnesses, type PaymentPrivateState} from '@pnyx/contract-client/payment-witnesses'
import {
  encodeShieldedAddress,
  parseMidnightAddress,
} from '../packages/wallet/account/derivation/midnight-address-encoding.js'
import {Contract} from '../contract/managed/payment/contract/index.js'
import {readPreprodWallet} from './preprod-wallet.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const managedDir = path.resolve(here, '../contract/managed/payment')
const outFile = path.resolve(here, '../.preprod-payment.json')

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

/**
 * Refuse a secret whose entropy is obviously absent. Not a strength test — a CSPRNG value cannot be
 * distinguished from a contrived one — but it does catch the mistake that actually happened: a repeated
 * or near-constant byte pattern reaching a deploy whose authority hash is public and brute-forceable.
 */
const assertStrongSecret = (secret: Uint8Array): void => {
  if (secret.length !== 32) {
    throw new Error(`admin secret must be 32 bytes, got ${secret.length}`)
  }
  const distinct = new Set(secret).size
  if (distinct < 16) {
    throw new Error(
      `refusing a low-entropy admin secret: only ${distinct} distinct byte values in 32 bytes. ` +
        'This is the mistake that let a fixture constant be recovered from the chain in 3.8 ms.',
    )
  }
}

/**
 * Generated here, never passed in. Preprod only — see the header.
 *
 * `nextAdminSecret` is unused by a deploy (no circuit runs), but the witness is declared for every
 * circuit so the private state must carry something. A fresh random value is discarded rather than
 * reusing the live secret, so a later rotation cannot accidentally install the secret it replaces.
 */
const GRANT_SECRET = new Uint8Array(randomBytes(32))
assertStrongSecret(GRANT_SECRET)
const ADMIN_AUTH = persistentHash32([pad32('pnyx:admin'), GRANT_SECRET])

const logger = createDefaultTestLogger()
const {masterSeed: seed, dustStateFile, unshieldedAddress, source} = await readPreprodWallet()
console.log(`\n=== payment.compact deploy ===\nseed from: ${source}\nunshielded address: ${unshieldedAddress}\n`)

const wallet = await assembleWallet(logger, env, seed, {dustStateFile})
await wallet.wallet.start(wallet.zswapSecretKeys, wallet.dustSecretKey)

const night = nightRaw()
let state = await waitForSections(wallet, 60 * 60_000, (s) => {
  const d = s.dust.state.progress
  console.log(
    `sync: unshielded=${s.unshielded.progress?.isStrictlyComplete() === true} dust=${d.appliedIndex}/${d.highestRelevantWalletIndex} NIGHT=${s.unshielded.balances[night] ?? 0n}`,
  )
})
await saveDustState(wallet as never, dustStateFile)

if ((state.unshielded.balances[night] ?? 0n) === 0n) {
  console.error(`\nNo NIGHT. Fund ${unshieldedAddress} and re-run.\n`)
  await wallet.stop()
  process.exit(2)
}
console.log(`NIGHT: ${state.unshielded.balances[night]}`)

while (state.dust.balance(new Date()) === 0n) {
  console.log('Waiting for DUST…')
  await new Promise((resolve) => setTimeout(resolve, 30_000))
  state = await currentFacadeState(wallet)
}
console.log(`DUST: ${state.dust.balance(new Date())}`)

// The treasury is this wallet's own unshielded address: a purchase is forwarded to it in the same
// circuit that receives it, so the contract never holds a float to publish (§3.4.2).
// Decoded from the wallet's own bech32 address rather than taken from the keystore: `getPublicKey()`
// returns the SDK's own encoding, and a `UserAddress` is the 32-byte payload the address carries.
const parsed = parseMidnightAddress(unshieldedAddress)
if (!parsed.ok || parsed.kind !== 'night') {
  throw new Error(`the wallet's unshielded address did not parse as a night address: ${unshieldedAddress}`)
}
const treasuryBytes = parsed.payload
const treasury = userRecipient(treasuryBytes)
console.log(`treasury (unshielded): ${Buffer.from(treasuryBytes).toString('hex')}`)

// ⚠️ **The shielded treasury is a coin public key, not the unshielded address again.**
// `sendImmediateShielded` addresses `Either<ZswapCoinPublicKey, ContractAddress>`, whose arms run the
// opposite way from the unshielded `Either<ContractAddress, UserAddress>`. This deploy previously
// passed `userRecipient(treasuryBytes)` here, which set `is_left: false` — naming a **contract** at a
// user's NIGHT address. No contract lives there, so every shielded purchase would have forwarded the
// coin to an owner that cannot exist, and the field is `sealed`, so only a redeploy could fix it.
const coinPublicKey = (wallet as unknown as {zswapSecretKeys: {coinPublicKey: string}}).zswapSecretKeys.coinPublicKey
if (!/^[0-9a-f]{64}$/i.test(coinPublicKey)) {
  throw new Error(`the wallet's coin public key is not 32 bytes of hex: ${coinPublicKey}`)
}
const shieldedTreasury = coinPublicKeyRecipient(Uint8Array.from(Buffer.from(coinPublicKey, 'hex')))
console.log(`treasury (shielded coin public key): ${coinPublicKey}`)

// ⚠️ **The encryption key has to be recorded here, because the contract cannot hold it.** A
// `ZswapCoinPublicKey` ledger field is half a shielded address; the other half is what lets a payer
// attach the ciphertext that makes the forwarded coin findable by an ordinary scan. Without it the
// treasury is write-only — it owns coins it can never see — and midnight-js refuses to build the
// purchase at all rather than silently omitting the ciphertext. It is public key material, so
// recording and publishing it costs nothing.
const encryptionPublicKey = (wallet as unknown as {zswapSecretKeys: {encryptionPublicKey: string}}).zswapSecretKeys
  .encryptionPublicKey
if (!/^[0-9a-f]{64}$/i.test(encryptionPublicKey)) {
  throw new Error(`the wallet's encryption public key is not 32 bytes of hex: ${encryptionPublicKey}`)
}
const shieldedTreasuryAddress = encodeShieldedAddress(
  Uint8Array.from(Buffer.from(coinPublicKey, 'hex')),
  Uint8Array.from(Buffer.from(encryptionPublicKey, 'hex')),
  'preprod',
)
console.log(`treasury (shielded address):         ${shieldedTreasuryAddress}`)

const privateState: PaymentPrivateState = {
  grantSecret: GRANT_SECRET,
  nextAdminSecret: new Uint8Array(randomBytes(32)),
}
const compiledContract = CompiledContract.make('PnyxPayment', Contract).pipe(
  CompiledContract.withWitnesses(createPaymentWitnesses()),
  CompiledContract.withCompiledFileAssets(managedDir),
)
const providers = initializeMidnightProviders(wallet, env, {
  zkConfigPath: managedDir,
  privateStateStoreName: 'pnyx-preprod-payment-state',
})

const attemptDeploy = async (attempt: number): Promise<Awaited<ReturnType<typeof deployContract>>> => {
  console.log(`Deploying payment.compact to preprod (attempt ${attempt})…`)
  try {
    return await deployContract(
      providers as never,
      {
        compiledContract,
        privateStateId: 'pnyxPaymentPreprod',
        initialPrivateState: privateState,
        args: [treasury, shieldedTreasury, ADMIN_AUTH],
      } as never,
    )
  } catch (error) {
    const text = error instanceof Error ? `${error.message}` : String(error)
    if (attempt < 15 && /dust|fee|insufficient|balance/i.test(text)) {
      console.log(`Attempt failed (${text.slice(0, 200)}); waiting 60s for more DUST…`)
      await new Promise((resolve) => setTimeout(resolve, 60_000))
      return attemptDeploy(attempt + 1)
    }
    throw error
  }
}
const deployed = await attemptDeploy(1)
const {contractAddress, blockHeight, txId} = deployed.deployTxData.public
console.log(`\n=== Deployed ===\npayment contract: ${contractAddress}\ntx: ${txId} @ block ${blockHeight}\n`)

fs.writeFileSync(
  outFile,
  `${JSON.stringify(
    {
      network: 'preprod',
      contractAddress,
      txId,
      blockHeight: String(blockHeight),
      adminAuth: Buffer.from(ADMIN_AUTH).toString('hex'),
      grantSecret: Buffer.from(GRANT_SECRET).toString('hex'),
      treasury: Buffer.from(treasuryBytes).toString('hex'),
      // Both halves, plus the address that carries them, because a payer needs the second one and
      // the contract's sealed field can only hold the first.
      shieldedTreasuryCoinPublicKey: coinPublicKey,
      shieldedTreasuryEncryptionPublicKey: encryptionPublicKey,
      shieldedTreasuryAddress,
      deployedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  {mode: 0o600},
)
console.log(`Recorded → ${outFile}`)
await saveDustState(wallet as never, dustStateFile)
await wallet.stop()
process.exit(0)
