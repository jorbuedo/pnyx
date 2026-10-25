/**
 * Read-only ("watch-only") Cardano import resolution.
 *
 * A watch-only wallet is usually identified by its stake credential. Given any
 * address of the account — a stake/reward address (`stake1…`) or one of its base
 * addresses (`addr1…`) — we resolve the reward address and enumerate every base
 * address the account has used on-chain via the stake endpoint (Koios
 * `/account_addresses`). No seed, no xpub, no gap-scan: "ownership" here is
 * defined purely as *shares this stake credential AND is a key-credential base
 * address*. Script-payment addresses under the same stake key (DEX/escrow,
 * multisig) are dropped — we can neither derive nor spend them.
 *
 * An address with no stake credential (enterprise) is watchable too, and resolves to
 * itself alone: there is no account behind it to enumerate, no reward account to read,
 * and nothing to delegate. The rail treats a `null` reward address as exactly that,
 * falling back to the per-address queries it already uses for providers without
 * account indexing.
 *
 * @module
 */

import {Provider as EvolutionProvider} from '@evolution-sdk/evolution'
import {Bech32} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {Data, Effect} from 'effect'
import {logger} from '../../logger'
import {fetchAllAccountAddresses} from './discovery'

export class ReadOnlyImportError extends Data.TaggedError('ReadOnlyImportError')<{
  readonly reason: 'invalid-address' | 'network-mismatch' | 'script-payment' | 'unsupported-provider' | 'no-addresses'
}> {}

export type ReadOnlyResolution = {
  /**
   * The account's reward (stake) address bech32 — the key for account-level Koios
   * lookups. `null` when watching a bare address, which belongs to no account.
   */
  readonly rewardAddressBech32: string | null
  /** The stake key hash (hex), or `null` for a bare address. */
  readonly stakeKeyHashHex: string | null
  /**
   * A stable per-wallet seed for the checksum/identicon: the stake key hash where
   * there is one, else the payment key hash. Never null, because the plate has to
   * be drawn either way.
   */
  readonly checksumSeedHex: string
  /**
   * Every key-credential base address under the stake key, sorted (primary = [0]) —
   * or exactly the one address given, when it has no stake credential to enumerate.
   */
  readonly addresses: readonly string[]
}

/** Key-credential base address: payment AND stake are both key hashes (not scripts). */
const isKeyCredentialBase = (info: Address.AddressInfo): boolean =>
  info.kind === Address.AddressKind.Base &&
  info.paymentCredHex !== undefined &&
  info.paymentIsScript !== true &&
  info.stakeCredHex !== undefined &&
  info.stakeIsScript !== true

/**
 * Keep only key-credential base addresses (drop script payments, scripts,
 * enterprise, and reward addresses). Undecodable entries are dropped. Pure over
 * the injected codec — reused by both import resolution and the runtime rail.
 */
export const filterKeyCredentialAddresses = (addresses: readonly string[]): readonly string[] =>
  addresses.filter((a) => {
    try {
      return isKeyCredentialBase(Address.inspect(Address.fromBech32Sync(Bech32(a))))
    } catch (e: unknown) {
      // `false` is also "this is a script address", the case this filter exists to drop — so an
      // address we own but failed to read leaves the watch-only rail's known set, which is what
      // decides whether history calls a transaction ours.
      logger.warn('Address could not be inspected; excluding it from the known set', {
        origin: 'cardano/read-only',
        error: String(e),
      })
      return false
    }
  })

/**
 * Ownership gate for account-level UTxO fetches. `account_utxos` returns every
 * UTxO under a stake key — including foreign addresses that merely share our
 * public stake credential. Given the verified owned-address set, keep only UTxOs
 * on an owned address. A `null` set means "no gate" (watch-only impersonates the whole account).
 *
 * ⚠️ `addressOf` rather than a `{address?: string}` constraint: the rows are Evolution `UTxO`s,
 * whose address is an `Address`. The old shape made it optional and dropped rows without one;
 * Evolution's `UTxO` requires it, so there is nothing to drop.
 */
export const keepOwnedAccountUtxos = <T>(
  utxos: readonly T[],
  ownSet: ReadonlySet<string> | null,
  addressOf: (utxo: T) => string,
): readonly T[] => (ownSet === null ? [...utxos] : utxos.filter((u) => ownSet.has(addressOf(u))))

/**
 * Resolve a watch-only import input into its reward address + full key-credential
 * base-address set. Accepts a reward address or any base address on `net`.
 */
export const resolveReadOnlyCardano = (
  net: Address.Network,
  input: string,
): Effect.Effect<ReadOnlyResolution, ReadOnlyImportError, EvolutionProvider.ProviderEffect> =>
  Effect.gen(function* () {
    const chain = yield* EvolutionProvider.ProviderEffect
    const trimmed = input.trim()
    if (trimmed.length === 0) return yield* Effect.fail(new ReadOnlyImportError({reason: 'invalid-address'}))

    const addressHex = yield* Effect.try({
      try: () => Address.fromBech32Sync(Bech32(trimmed)),
      catch: () => new ReadOnlyImportError({reason: 'invalid-address'}),
    })
    const info = yield* Effect.try({
      try: () => Address.inspect(addressHex),
      catch: () => new ReadOnlyImportError({reason: 'invalid-address'}),
    })

    if (info.networkId !== net) return yield* Effect.fail(new ReadOnlyImportError({reason: 'network-mismatch'}))
    // No stake credential (enterprise), or one we cannot enumerate against (a script
    // stake key belongs to a shared wallet, not to this account): the wallet is exactly
    // the address it was given. Nothing to discover, and no reward account to read.
    //
    // A *reward* address is never in this branch — it carries a stake credential and no
    // payment one — so the payment check below is only ever asked of an address that has
    // a payment part to check.
    if (info.stakeCredHex === undefined || info.stakeIsScript === true) {
      if (info.paymentCredHex === undefined || info.paymentIsScript === true) {
        return yield* Effect.fail(new ReadOnlyImportError({reason: 'script-payment'}))
      }
      return {
        rewardAddressBech32: null,
        stakeKeyHashHex: null,
        checksumSeedHex: info.paymentCredHex,
        addresses: [trimmed],
      }
    }
    // Past here the account is enumerable, and a base-address input must itself be a key
    // credential: a script payment over our stake key is an escrow, not ours to watch.
    if (info.kind === Address.AddressKind.Base && info.paymentIsScript === true) {
      return yield* Effect.fail(new ReadOnlyImportError({reason: 'script-payment'}))
    }

    const inputBase = info.kind === Address.AddressKind.Base ? trimmed : null

    const rewardAddressBech32 = Address.toBech32Sync(Address.rewardHex(net, info.stakeCredHex))

    if (chain.getAccountAddresses === undefined) {
      return yield* Effect.fail(new ReadOnlyImportError({reason: 'unsupported-provider'}))
    }
    const all = yield* fetchAllAccountAddresses(chain.getAccountAddresses, rewardAddressBech32)
    const set = new Set(filterKeyCredentialAddresses(all))
    // The input base address may not be indexed yet — always include it.
    if (inputBase !== null) set.add(inputBase)
    const addresses = [...set].sort()
    if (addresses.length === 0) return yield* Effect.fail(new ReadOnlyImportError({reason: 'no-addresses'}))
    return {
      rewardAddressBech32,
      stakeKeyHashHex: info.stakeCredHex,
      checksumSeedHex: info.stakeCredHex,
      addresses,
    }
  })
