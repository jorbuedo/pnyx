// Which preprod wallet a harness script runs as, and its dust-state cache.
//
// One shared reader because the four preprod scripts each had their own copy of "parse
// .preprod-wallet.json, take masterSeed" — and one of them, `deploy-preprod.ts`, *minted* a wallet with
// `randomBytes(32)` when the file was missing. That is how the old sponsor came to exist in a format the
// app can never open (`docs/SPONSOR_HOST.md`, "the seed is a mnemonic"): a hex seed is a dead end the
// moment anything but the harness needs the wallet.
//
// So: a mnemonic, or nothing. `PREPROD_MNEMONIC` wins over the file, which makes running a script as some
// *other* wallet — the app's abandon test wallet, say — a one-liner rather than an edit.
//
// A missing wallet is refused, never invented. `createPreprodWallet` is the only path that writes one,
// it is explicit, and it asserts the wallet is openable in the app before returning.
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {masterSeedFrom} from '@pnyx/chain-client/master-seed'
import {DustSecretKey} from '@midnight-ntwrk/ledger-v8'
import {NetworkId, createKeystore} from '@midnight-ntwrk/wallet-sdk'
import {WalletSeeds} from '@midnight-ntwrk/testkit-js'
import {generateMnemonic} from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'
import {Effect} from 'effect'
import {encodeDustAddress} from '../packages/wallet/account/derivation/midnight-address-encoding.js'
import {
  deriveMidnightDustAddress,
  deriveMidnightNightAddress,
} from '../packages/wallet/account/derivation/midnight.js'
import {mnemonicToSeed} from '../packages/wallet/account/seed.js'

const here = path.dirname(fileURLToPath(import.meta.url))

export const preprodWalletFile = path.resolve(here, '../.preprod-wallet.json')

export type PreprodWallet = {
  /** Hex, for `assembleWallet` / `WalletSeeds.fromMasterSeed`. */
  readonly masterSeed: string
  readonly unshieldedAddress: string
  /**
   * Dust snapshot path for *this* wallet.
   *
   * Per-wallet, because a snapshot is the serialized state of one dust secret key: restoring the
   * sponsor's snapshot into another wallet's dust section is not an error the SDK reports, it is a
   * balance readout that means nothing. The old single `.preprod-dust-state.gz` was safe only while
   * exactly one wallet existed.
   */
  readonly dustStateFile: string
  /** Where the seed came from, for the log line that says which wallet this run is. */
  readonly source: string
}

const dustStateFileFor = (address: string): string =>
  path.resolve(here, `../.preprod-dust-state.${address.slice(-12)}.gz`)

/** The address the wallet SDK's keystore reports — no network, no facade, just the keys. */
const sdkAddress = (masterSeed: string): string =>
  createKeystore(WalletSeeds.fromMasterSeed(masterSeed).unshielded, NetworkId.NetworkId.PreProd as never)
    .getBech32Address()
    .asString()

/** The address the *app* derives from the same phrase. Must agree, or the wallet is only half real. */
const appAddress = (seed: Uint8Array): Promise<string> =>
  Effect.runPromise(deriveMidnightNightAddress(seed, {networkId: 'preprod'}))

/**
 * The DUST address, from each side's own role derivation.
 *
 * Worth its own check rather than trusting the night address to cover it: DUST is role 2 and the
 * published SDK guide said role 4 until `midnightntwrk/midnight-docs#1248`, so a wallet can hold a
 * correct night address and still derive its DUST from the metadata key — which strands every fee it
 * generates. The night addresses agreeing says nothing about that.
 */
const sdkDustAddress = (masterSeed: string): string =>
  encodeDustAddress(DustSecretKey.fromSeed(WalletSeeds.fromMasterSeed(masterSeed).dust).publicKey, 'preprod')

const appDustAddress = (seed: Uint8Array): Promise<string> =>
  Effect.runPromise(deriveMidnightDustAddress(seed, {networkId: 'preprod'}))

const resolve = async (text: string, source: string): Promise<PreprodWallet> => {
  const seed = masterSeedFrom(text)
  if (!seed.ok) {
    console.error(`${source} holds ${seed.reason}`)
    process.exit(2)
  }
  const address = sdkAddress(seed.masterSeed)
  if (seed.format === 'mnemonic') {
    // Cheap, offline, and the one check that catches a wallet the app cannot open.
    const seedBytes = await mnemonicToSeed(text.trim().split(/\s+/).join(' '))
    const derived = await appAddress(seedBytes)
    if (derived !== address) {
      console.error(
        `${source} derives two different wallets:\n  wallet SDK: ${address}\n  app:        ${derived}\nRefusing to run.`,
      )
      process.exit(2)
    }
    const sdkDust = sdkDustAddress(seed.masterSeed)
    const appDust = await appDustAddress(seedBytes)
    if (sdkDust !== appDust) {
      console.error(
        `${source} derives two different DUST addresses:\n  wallet SDK: ${sdkDust}\n  app:        ${appDust}\n` +
          'Refusing to run: the app would show a DUST balance that is not the one paying these fees.',
      )
      process.exit(2)
    }
  }
  return {
    masterSeed: seed.masterSeed,
    unshieldedAddress: address,
    dustStateFile: dustStateFileFor(address),
    source: `${source} (${seed.summary})`,
  }
}

/**
 * The wallet this run uses: `PREPROD_MNEMONIC`, else `.preprod-wallet.json`, else nothing.
 *
 * Nothing means exit, not a fresh wallet — an invented wallet reports an empty balance that says
 * nothing about the wallet the caller meant, and takes a ~15 min dust sync to say it.
 */
export const readPreprodWallet = async (): Promise<PreprodWallet> => {
  const fromEnv = process.env.PREPROD_MNEMONIC
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv, 'PREPROD_MNEMONIC')
  if (!fs.existsSync(preprodWalletFile)) {
    console.error(
      `No ${preprodWalletFile}.\n` +
        'Put a BIP-39 mnemonic there as {"network":"preprod","mnemonic":"…"} (mode 0600), or pass\n' +
        'PREPROD_MNEMONIC=… for a one-off run. A wallet is never created implicitly.',
    )
    process.exit(2)
  }
  let file: {mnemonic?: string; masterSeed?: string}
  try {
    file = JSON.parse(fs.readFileSync(preprodWalletFile, 'utf8'))
  } catch (error) {
    console.error(`could not read ${preprodWalletFile}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
  const secret = file.mnemonic ?? file.masterSeed
  if (secret === undefined) {
    console.error(`${preprodWalletFile} has neither a "mnemonic" nor a "masterSeed" field`)
    process.exit(2)
  }
  return resolve(secret, preprodWalletFile)
}

/**
 * Create `.preprod-wallet.json` from a fresh 24-word mnemonic. Only `deploy:preprod` calls this, and
 * only when there is nothing to reuse.
 *
 * The phrase is printed once: a wallet whose phrase exists only in a file the operator has not seen is
 * one they cannot recover, and on preprod that is the whole point of having it.
 */
export const createPreprodWallet = async (): Promise<PreprodWallet> => {
  const mnemonic = generateMnemonic(wordlist, 256)
  const wallet = await resolve(mnemonic, 'a newly generated mnemonic')
  fs.writeFileSync(
    preprodWalletFile,
    `${JSON.stringify({network: 'preprod', mnemonic, unshieldedAddress: wallet.unshieldedAddress}, null, 2)}\n`,
    {mode: 0o600},
  )
  console.log(
    [
      '',
      `Created a preprod wallet → ${preprodWalletFile}`,
      `  address:  ${wallet.unshieldedAddress}`,
      `  mnemonic: ${mnemonic}`,
      '',
      'Write the phrase down. It restores in the app, which a hex seed never could.',
      '',
    ].join('\n'),
  )
  return {...wallet, source: preprodWalletFile}
}
