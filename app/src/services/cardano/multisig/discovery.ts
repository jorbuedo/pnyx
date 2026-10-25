/**
 * Address discovery and balance for a shared wallet.
 *
 * A CIP-1854 wallet has an address per payment index, not one address, so its
 * funds are spread across however many indexes have been used. Discovery walks
 * indexes forward until it has seen {@link MULTISIG_ADDRESS_GAP} consecutive
 * unused ones — the same gap rule as BIP-44, and what the CIP means by "always
 * provide up-to 20 consecutive unused multisig keys".
 *
 * The scan takes its UTxO reader as a parameter rather than importing a
 * provider, so the gap logic is testable without a network.
 *
 * @module
 */

import {
  Bytes,
  Address as EvolutionAddress,
  Provider as EvolutionProvider,
  type UTxO as EvolutionUTxO,
  TransactionHash,
} from '@evolution-sdk/evolution'
import type {Bech32} from '@evolution-sdk/review/Brands'
import type {CoreError} from '@pnyx/cardano-core/Op'
import {Effect} from 'effect'
import {type KoiosRefusal, retryKoiosRefusal} from '../koios-refusal'
import {type SharedScripts, scriptsAt} from './derive'
import {MULTISIG_ADDRESS_GAP, type SharedWallet} from './types'

/** One asset held at a shared address. */
export type SharedAsset = {
  readonly policyHex: string
  readonly nameHex: string
  readonly quantity: bigint
}

export type SharedUtxo = {
  readonly txHash: string
  readonly index: number
  readonly coin: bigint
  readonly assets: readonly SharedAsset[]
  /** Which payment index the address it sits at was derived from — needed to sign it. */
  readonly keyIndex: number
  readonly addressBech32: string
}

/** A chain UTxO as the gap scan reads it: what the walk needs and nothing more. */
export type ScanUtxo = {
  readonly txHash: string
  readonly index: number
  readonly coin: bigint
  readonly assets: readonly SharedAsset[]
}

/** Reads the UTxOs at one address. Supplied by the caller, over the rail's chain client. */
export type UtxoReader = (addressBech32: Bech32) => Effect.Effect<readonly ScanUtxo[], CoreError>

/**
 * The edge where a typed chain row becomes the scan's shape.
 *
 * ⚠️ The scan works in hex because a shared wallet's address book and its **persisted** scan
 * state do, so this conversion is a serialization boundary rather than a leftover. One
 * implementation: it was written twice, in the rail resolver and in the wallets hook, and two
 * copies of a conversion are how the two come to disagree about what an address holds.
 */
export const scanUtxoOf = (u: EvolutionUTxO.UTxO): ScanUtxo => ({
  txHash: TransactionHash.toHex(u.transactionId),
  index: Number(u.index),
  coin: u.assets.lovelace,
  assets: [...(u.assets.multiAsset?.map.entries() ?? [])].flatMap(([policy, names]) =>
    [...names.entries()].map(([name, quantity]) => ({
      policyHex: Bytes.toHex(policy.hash),
      nameHex: Bytes.toHex(name.bytes),
      quantity,
    })),
  ),
})

export type DiscoveredAddress = {
  readonly scripts: SharedScripts
  readonly utxos: readonly SharedUtxo[]
  readonly used: boolean
}

export type Discovery = {
  readonly addresses: readonly DiscoveredAddress[]
  readonly utxos: readonly SharedUtxo[]
  readonly coin: bigint
  readonly assets: readonly SharedAsset[]
  /** Lowest index with no UTxOs — where a fresh receive address comes from. */
  readonly nextUnusedIndex: number
  /**
   * True when the scan stopped at {@link maxIndexes} rather than on the gap.
   *
   * Surfaced rather than swallowed: a truncated scan under-reports the balance,
   * and a wallet quietly showing less than it holds is worse than one saying it
   * could not finish looking.
   */
  readonly truncated: boolean
}

/** Sum quantities per (policy, name) across UTxOs. */
export const sumAssets = (utxos: readonly SharedUtxo[]): readonly SharedAsset[] => {
  const totals = new Map<string, SharedAsset>()
  for (const utxo of utxos) {
    for (const asset of utxo.assets) {
      const key = `${asset.policyHex}.${asset.nameHex}`
      const running = totals.get(key)
      totals.set(key, running === undefined ? asset : {...running, quantity: running.quantity + asset.quantity})
    }
  }
  return [...totals.values()]
}

/**
 * The gap scan's UTxO reader, over Evolution's typed chain client.
 *
 * Two things beyond "read the address". A Koios refusal is asked again rather than
 * ending the walk: the scan is ~20 sequential calls and one 429 anywhere in it used
 * to take the wallet's whole rail down, including refusals nothing we sent had
 * earned. And a failure that survives the retries stays a failure — it must never
 * read as an empty address, because that would move the wallet's spending index to
 * one holding nothing.
 *
 * ⚠️ The bech32 is decoded inside the typed channel, not in the function body: the walk
 * `yield*`s this reader, so a throw from `fromBech32` would be a defect that no caller's
 * error handling sees, where a malformed address book deserves to be reported as one.
 */
export const sharedScanReader =
  (getUtxos: EvolutionProvider.ProviderEffect['getUtxos'], onRefusal: (refusal: KoiosRefusal) => void): UtxoReader =>
  (address) =>
    Effect.try({
      try: () => EvolutionAddress.fromBech32(address),
      catch: (e) => new EvolutionProvider.ProviderError({message: `malformed shared address ${address}`, cause: e}),
    }).pipe(
      Effect.flatMap((decoded) => retryKoiosRefusal(getUtxos(decoded), {reasonOf: (e) => e.message, onRefusal})),
      Effect.map((utxos) => utxos.map(scanUtxoOf)),
      Effect.mapError((e) => new Error(e.message) as never),
    )

/**
 * Walk payment indexes until `gap` consecutive addresses come back empty.
 *
 * The gap counter resets on every used address, so a wallet with a hole in its
 * index range is still fully discovered — stopping at the first empty address
 * would miss everything past a skipped index.
 */
export const discoverSharedWallet = (
  wallet: SharedWallet,
  readUtxos: UtxoReader,
  opts?: {readonly gap?: number; readonly maxIndexes?: number},
): Effect.Effect<Discovery, CoreError> =>
  Effect.gen(function* () {
    const gap = opts?.gap ?? MULTISIG_ADDRESS_GAP
    const maxIndexes = opts?.maxIndexes ?? 200
    const addresses: DiscoveredAddress[] = []
    let consecutiveEmpty = 0
    let index = 0
    let truncated = false

    while (consecutiveEmpty < gap) {
      if (index >= maxIndexes) {
        truncated = true
        break
      }
      const scripts = yield* scriptsAt(wallet, index)
      const raw = yield* readUtxos(scripts.addressBech32)
      const utxos = raw.map((u): SharedUtxo => ({...u, keyIndex: index, addressBech32: scripts.addressBech32}))
      const used = utxos.length > 0
      addresses.push({scripts, utxos, used})
      consecutiveEmpty = used ? 0 : consecutiveEmpty + 1
      index += 1
    }

    const utxos = addresses.flatMap((a) => a.utxos)
    const firstUnused = addresses.find((a) => !a.used)
    return {
      addresses,
      utxos,
      coin: utxos.reduce((sum, u) => sum + u.coin, 0n),
      assets: sumAssets(utxos),
      // With no unused address in range the scan was truncated, so the next
      // index is past everything looked at rather than an arbitrary 0.
      nextUnusedIndex: firstUnused?.scripts.index ?? addresses.length,
      truncated,
    }
  })

/** The UTxOs to spend for `target` lovelace, largest first, with what they total. */
export const selectUtxos = (
  utxos: readonly SharedUtxo[],
  target: bigint,
): {readonly selected: readonly SharedUtxo[]; readonly total: bigint; readonly sufficient: boolean} => {
  const ordered = [...utxos].sort((a, b) => (b.coin === a.coin ? 0 : b.coin > a.coin ? 1 : -1))
  const selected: SharedUtxo[] = []
  let total = 0n
  for (const utxo of ordered) {
    if (total >= target) break
    selected.push(utxo)
    total += utxo.coin
  }
  return {selected, total, sufficient: total >= target}
}

/**
 * The payment indexes a set of UTxOs spans.
 *
 * Signing needs one witness per index in play, because a co-signer's key is
 * different at every index — spending across three indexes means three
 * signatures from each required co-signer, not one.
 */
export const indexesOf = (utxos: readonly SharedUtxo[]): readonly number[] =>
  [...new Set(utxos.map((u) => u.keyIndex))].sort((a, b) => a - b)
