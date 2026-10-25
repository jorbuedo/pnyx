/**
 * Reading a co-contributor's UTxOs through the composer's rail.
 *
 * The composer holds the only provider connection involved. A co-contributor is known
 * through a read-only wallet, which is an **address list** — the shipped importer resolves
 * a stake credential to one and stores no xpub — so their UTxOs are data the composer
 * already has and their keys are not. Selecting inputs takes knowledge; only witnessing
 * takes a key.
 *
 * Deliberately not a second `CardanoRail`. A rail carries a key registry, a pending-tx
 * tracker, persistence and signing paths, none of which apply to a wallet this device
 * cannot sign for, and building one would invite exactly the mistake of treating a watched
 * wallet as a spendable one.
 *
 * **One account call, not a per-address fanout.** The first attempt looped `utxosAt` over
 * every known address and every wallet timed out — Koios takes one address per
 * `/address_utxos` call, gap-scanned wallets have dozens, and four wallets produced 408s
 * across the board. `accountUtxos` asks `/account_utxos` for the whole stake account in one
 * paginated call, which is what the rail itself does for watch-only imports. The fanout
 * survives only as the fallback for a provider that does not implement it.
 *
 * **What this cannot see is what the co-contributor has already spent.** Their pending
 * transactions live on their device; the composer sees confirmed chain state only. So a
 * body built here can name an input they have since spent, and the failure surfaces at
 * submit. That is a property of watching rather than a defect to paper over — the
 * co-signer's own client re-checks before signing, where the pending set is real.
 *
 * @module
 */

import {
  Bytes,
  Address as EvolutionAddress,
  type UTxO as EvolutionUTxO,
  RewardAddress,
  TransactionHash,
} from '@evolution-sdk/evolution'
import {Bech32} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {Data, Effect} from 'effect'
import {logger} from '../../../logger'
import type {CardanoRail} from '../rail'
import {rewardAddressFor} from '../reward-address'
import type {ContributedUtxo} from './compose'

export class GatherError extends Data.TaggedError('GatherError')<{
  readonly reason: string
  readonly addressBech32?: string
}> {}

/**
 * What gathering needs from the rail: the two UTxO queries, and nothing else.
 *
 * Narrower than `CardanoRail`, which a rail still satisfies structurally — see
 * `MultipartyBuildRail` for why this is a named type rather than a cast at each test.
 * It also states the thing the module doc argues: no key registry, no signing path, no
 * pending tracker. A watched wallet is read, never spent from here.
 *
 * ⚠️ It used to carry a one-method `codec` slice as well. Reading an address needs no codec.
 */
export type GatherRail = {
  readonly chain: {
    readonly getAccountUtxos?: CardanoRail['chain']['getAccountUtxos']
    readonly getUtxos: CardanoRail['chain']['getUtxos']
  }
}

/** Koios pages `/account_utxos`; this is the page size the rail uses for the same call. */
const PAGE = 1000

/**
 * The stake account behind a wallet's addresses, or `null` for an address set with none.
 *
 * Every base address of one wallet shares a stake credential, so the first readable one
 * answers for all of them. An enterprise address has none, and such a wallet has to fall
 * back to the fanout.
 *
 * ⚠️ **`Address.inspect` parses the hex form, not bech32.** Handed a `addr1…` it decodes
 * the characters as bytes and reads a header out of nonsense — no error, just a wrong
 * answer. Takes the hex the caller already derived.
 */
const stakeAccountOf = (addressHexes: readonly string[]): string | null => {
  for (const addressHex of addressHexes) {
    try {
      const info = Address.inspect(addressHex)
      if (info.stakeCredHex === undefined) continue
      const reward = rewardAddressFor(info.networkId, {
        hashHex: info.stakeCredHex,
        type: info.stakeIsScript === true ? 'script' : 'key',
      })
      if (reward !== undefined) return reward
    } catch (e: unknown) {
      // An address we cannot read tells us nothing about the account; try the next. Silently,
      // though, a roster of unreadable addresses and one with no reward address are the same.
      logger.debug('Address could not be read while looking for a reward address; trying the next', {
        origin: 'multiparty/gather',
        error: String(e),
      })
    }
  }
  return null
}

/**
 * A chain row to a contributable input.
 *
 * ⚠️ The asset key is `policy.name`, with a dot, and the name half may be empty — that is a
 * real asset name, not a missing one. Same key the rail's own UTxO conversion emits.
 */
const toContributed = (utxo: EvolutionUTxO.UTxO, addressHex: string): ContributedUtxo => {
  const assets = new Map<string, bigint>()
  for (const [policy, names] of utxo.assets.multiAsset?.map.entries() ?? []) {
    for (const [name, quantity] of names.entries()) {
      assets.set(`${Bytes.toHex(policy.hash)}.${Bytes.toHex(name.bytes)}`, quantity)
    }
  }
  return {
    txHash: TransactionHash.toHex(utxo.transactionId),
    index: Number(utxo.index),
    addressHex,
    lovelace: utxo.assets.lovelace,
    ...(assets.size > 0 ? {assets} : {}),
  }
}

/**
 * Every confirmed UTxO of a watched wallet, as contributable inputs.
 *
 * ⚠️ The account read is gated on the addresses this wallet actually derived: a stake
 * credential is public, so `/account_utxos` can return UTxOs at a *foreign* address that
 * merely delegates to the same account. Contributing one would build a body naming an
 * input this party cannot witness.
 */
export const gatherContributableUtxos = (params: {
  readonly rail: GatherRail
  readonly addresses: readonly string[]
}): Effect.Effect<readonly ContributedUtxo[], GatherError> =>
  Effect.gen(function* () {
    const {rail, addresses} = params
    const hexByBech32 = new Map<string, string>()
    for (const bech32 of addresses) {
      try {
        hexByBech32.set(bech32, Address.fromBech32Sync(Bech32(bech32)))
      } catch (e: unknown) {
        // Unreadable here means unusable as a return address later, so it is simply not
        // contributable. Skipped rather than fatal: one odd row must not hide a wallet — but a
        // wallet that contributes nothing because every row was skipped must be diagnosable.
        logger.warn('Address could not be decoded; it cannot be contributed to the gather', {
          origin: 'multiparty/gather',
          error: String(e),
        })
      }
    }
    if (hexByBech32.size === 0) {
      return yield* Effect.fail(new GatherError({reason: 'no readable addresses'}))
    }

    const stake = stakeAccountOf([...hexByBech32.values()])
    const accountUtxos = rail.chain.getAccountUtxos
    if (stake !== null && accountUtxos !== undefined) {
      const gathered: ContributedUtxo[] = []
      const rewardAddress = RewardAddress.RewardAddress.make(stake)
      for (let offset = 0; ; offset += PAGE) {
        const page = yield* accountUtxos(rewardAddress, {offset, limit: PAGE}).pipe(
          Effect.mapError((e) => new GatherError({reason: e.message})),
        )
        for (const utxo of page) {
          // ⚠️ Ownership stays gated on OUR derivation: an address the account holds that we
          // never derived is simply not in the map, so a foreign payment key sharing this
          // public stake credential contributes nothing. An address is REQUIRED on a typed
          // row, so there is no "row without one" case to decide any more.
          const hex = hexByBech32.get(EvolutionAddress.toBech32(utxo.address))
          if (hex === undefined) continue
          gathered.push(toContributed(utxo, hex))
        }
        if (page.length < PAGE) break
      }
      // A stake account with UTxOs of which none are ours means the address set and the
      // account disagree — worth saying, because the caller sees only an empty wallet.
      logger.info('co-fund: account read', {
        origin: 'gatherContributableUtxos',
        owned: hexByBech32.size,
        gathered: gathered.length,
      })
      return gathered
    }

    // No stake credential, or a provider without the account query. Sequential, because a
    // fanout of dozens of concurrent calls is how the shared Koios bucket gets exhausted.
    const gathered: ContributedUtxo[] = []
    for (const [bech32, addressHex] of hexByBech32) {
      const utxos = yield* Effect.try({
        try: () => EvolutionAddress.fromBech32(bech32),
        catch: (e) => new GatherError({reason: `address did not decode: ${String(e)}`, addressBech32: bech32}),
      }).pipe(
        Effect.flatMap((address) =>
          rail.chain
            .getUtxos(address)
            .pipe(Effect.mapError((e) => new GatherError({reason: e.message, addressBech32: bech32}))),
        ),
      )
      for (const utxo of utxos) gathered.push(toContributed(utxo, addressHex))
    }
    return gathered
  })

/** Total lovelace across a gathered set — what the picker shows as available. */
export const contributableTotal = (utxos: readonly ContributedUtxo[]): bigint =>
  utxos.reduce((total, utxo) => total + utxo.lovelace, 0n)
