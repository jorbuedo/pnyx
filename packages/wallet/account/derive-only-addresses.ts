/**
 * Derive-only multi-chain receive addresses (BTC / EVM / SOL / Cardano).
 *
 * These chains get address-only treatment — no balance, activity, or submit
 * infrastructure (docs/mobile-shell-plan.md phase 6).
 *
 * The persistence model splits by whether the address is reproducible from the
 * account **xpub** (public material, persisted at import):
 *  - BTC / EVM / Cardano ARE xpub-derivable, so import persists no address row
 *    for them — the index-0 receive address is rebuilt on read from the xpub via
 *    {@link resolveDeriveOnlyAddresses}, and Cardano's full book comes from
 *    seedless discovery (external / internal rows).
 *  - SOL is NOT xpub-derivable (SLIP-0010 hardened, no public-child derivation),
 *    so its address row is the only copy and MUST be persisted at import while
 *    the mnemonic is in memory — see {@link persistDeriveOnlyAddresses}.
 *
 * Persisted rows live in each chain's own `(groupId, chainId, accountIndex)`
 * partition. Addresses are the mainnet forms (an EVM / Solana address is
 * network-agnostic; Bitcoin uses the `bc1` mainnet form) — this is the user's
 * cross-chain receive surface, not tied to the Midnight identity network.
 *
 * @module
 */

import {BITCOIN_MAINNET, CARDANO_MAINNET, type ChainId, ETHEREUM_MAINNET, SOLANA_MAINNET} from '@pnyx/config'
import {getLogger} from '@pnyx/logger'
import type {AddressRef, AddressRow} from '@pnyx/store/address-table'
import type {StoreErrors} from '@pnyx/store/errors'
import {Effect} from 'effect'
import {DerivationError} from '../errors.js'
import type {Network} from '../types.js'

const logger = getLogger('wallet')

import {createAddressGeneratorForChain} from './address-generator.js'
import {deriveBitcoinAddress} from './derivation/bitcoin.js'
import {deriveEvmAddress} from './derivation/evm.js'
import {deriveSolanaAddress} from './derivation/solana.js'
import {mnemonicToSeed} from './seed.js'

/** The derive-only chains, in display order. */
export const DERIVE_ONLY_CHAINS = ['bitcoin', 'evm', 'solana', 'cardano'] as const
export type DeriveOnlyChain = (typeof DERIVE_ONLY_CHAINS)[number]

/** The `ChainId` partition each derive-only chain's address is stored under. */
export const DERIVE_ONLY_CHAIN_IDS: Record<DeriveOnlyChain, ChainId> = {
  bitcoin: BITCOIN_MAINNET,
  evm: ETHEREUM_MAINNET,
  solana: SOLANA_MAINNET,
  cardano: CARDANO_MAINNET,
}

export type DeriveOnlyAddresses = Record<DeriveOnlyChain, string>

/** The seed (SLIP-0010) derived chains — Cardano is entropy-derived and handled separately. */
type SeedDeriveOnlyAddresses = Omit<DeriveOnlyAddresses, 'cardano'>

/** The address-table surface this module needs — satisfied by `WalletDataStore` and a raw `AddressTable`. */
export type DeriveOnlyAddressStore = {
  readonly getAddress: (
    ref: AddressRef,
    branch: 'external' | 'internal' | 'single',
    index: number,
  ) => Effect.Effect<AddressRow | null, StoreErrors>
  readonly upsertAddresses: (rows: readonly AddressRow[]) => Effect.Effect<void, StoreErrors>
}

const refFor = (groupId: string, accountIndex: number, chain: DeriveOnlyChain): AddressRef => ({
  groupId,
  chainId: DERIVE_ONLY_CHAIN_IDS[chain],
  accountIndex,
})

/** Derive the SLIP-0010 (seed-based) derive-only addresses. Cardano is derived from
 *  the mnemonic (entropy) separately — see {@link deriveCardanoAddress}. */
export const deriveAllFromSeed = (
  seed: Uint8Array,
  account: number,
): Effect.Effect<SeedDeriveOnlyAddresses, DerivationError> =>
  Effect.all({
    bitcoin: deriveBitcoinAddress(seed, {account}),
    evm: deriveEvmAddress(seed, {account}),
    solana: deriveSolanaAddress(seed, {account}),
  })

const seedFromMnemonic = (mnemonic: string): Effect.Effect<Uint8Array, DerivationError> =>
  Effect.tryPromise({
    try: () => mnemonicToSeed(mnemonic),
    catch: (cause) =>
      new DerivationError({
        message: `Failed to derive seed for derive-only addresses: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })

/** The derive-only chains whose address is NOT reproducible from the account
 *  xpub and therefore MUST be persisted at import (SLIP-0010 hardened / no
 *  public-child derivation). Everything else is derived from the xpub on read. */
export const DERIVE_ONLY_PERSISTED_CHAINS: readonly DeriveOnlyChain[] = ['solana']

/**
 * Persist the derive-only address rows that cannot be rebuilt from the account
 * xpub — currently Solana only (SLIP-0010 hardened; no public-child derivation),
 * so its row is the sole copy and is written here while the mnemonic is in
 * memory. BTC / EVM / Cardano are xpub-derivable and get no row at import: their
 * receive address is resolved on read via {@link resolveDeriveOnlyAddresses} and
 * Cardano's book is populated by seedless discovery. Idempotent: if the Solana
 * `single`/0 row already exists, derivation is skipped. Account = `accountIndex`.
 */
export const persistDeriveOnlyAddresses = (params: {
  readonly store: DeriveOnlyAddressStore
  readonly groupId: string
  readonly accountIndex: number
  readonly mnemonic: string
}): Effect.Effect<'stored' | 'already-stored', DerivationError | StoreErrors> =>
  Effect.gen(function* () {
    const {store, groupId, accountIndex, mnemonic} = params
    const existing = yield* store.getAddress(refFor(groupId, accountIndex, 'solana'), 'single', 0)
    if (existing !== null) return 'already-stored' as const

    const seed = yield* seedFromMnemonic(mnemonic)
    const solana = yield* deriveSolanaAddress(seed, {account: accountIndex})
    const rows: readonly AddressRow[] = DERIVE_ONLY_PERSISTED_CHAINS.map((chain) => ({
      ...refFor(groupId, accountIndex, chain),
      branch: 'single' as const,
      index: 0,
      human: solana,
      hash: solana,
      isUsed: false,
    }))
    yield* store.upsertAddresses(rows)
    return 'stored' as const
  })

/**
 * Persist a derive-only receive address obtained directly from a hardware
 * device — the seed-based {@link persistDeriveOnlyAddresses} can't run because a
 * hardware wallet has no seed. Used for Solana (hardened path, no public-child
 * derivation), whose device-returned address is the only copy. BTC/EVM/Cardano
 * are NOT persisted here — their xpub is stored instead and the address rebuilds
 * on read. Idempotent: skips when a non-empty row already exists.
 */
export const persistDeviceDeriveOnlyAddress = (params: {
  readonly store: Pick<DeriveOnlyAddressStore, 'getAddress' | 'upsertAddresses'>
  readonly groupId: string
  readonly chain: DeriveOnlyChain
  readonly accountIndex: number
  readonly address: string
}): Effect.Effect<'stored' | 'already-stored', StoreErrors> =>
  Effect.gen(function* () {
    const {store, groupId, chain, accountIndex, address} = params
    const ref = refFor(groupId, accountIndex, chain)
    const existing = yield* store.getAddress(ref, 'single', 0)
    if (existing !== null && existing.human.length > 0) return 'already-stored' as const
    yield* store.upsertAddresses([
      {...ref, branch: 'single' as const, index: 0, human: address, hash: address, isUsed: false},
    ])
    return 'stored' as const
  })

/**
 * Read whichever derive-only addresses are already stored for the group/account.
 * Returns only the chains present (empty object if none derived yet — never
 * re-derives on read, since that needs the seed).
 */
export const getStoredDeriveOnlyAddresses = (params: {
  readonly store: Pick<DeriveOnlyAddressStore, 'getAddress'>
  readonly groupId: string
  readonly accountIndex: number
}): Effect.Effect<Partial<DeriveOnlyAddresses>, StoreErrors> =>
  Effect.gen(function* () {
    const {store, groupId, accountIndex} = params
    const out: Partial<DeriveOnlyAddresses> = {}
    for (const chain of DERIVE_ONLY_CHAINS) {
      const row = yield* store.getAddress(refFor(groupId, accountIndex, chain), 'single', 0)
      if (row !== null && row.human.length > 0) out[chain] = row.human
    }
    return out
  })

/** The derive-only chains whose index-0 receive address is reproducible from the persisted account xpub (no seed). */
export const DERIVE_ONLY_XPUB_CHAINS: ReadonlySet<DeriveOnlyChain> = new Set(['bitcoin', 'evm', 'cardano'])

/** Look up the account-level xpub bytes for a chain, or `null` when none is persisted. Must never prompt / touch the vault. */
export type AccountXpubLookup = (chainId: ChainId) => Effect.Effect<Uint8Array | null, never>

export type ResolvedDeriveOnlyAddresses = {
  readonly addresses: Partial<DeriveOnlyAddresses>
  /** A chain had neither a stored row nor a derivable xpub — the caller should schedule a prompt-free xpub backfill. */
  readonly needsBackfill: boolean
}

/**
 * The address-table branch each chain's canonical receive address is read from:
 * Cardano's book is owned by discovery (`external`/`internal` rows), so its
 * receive address is `external[0]`; the others use the single-address slot.
 */
const READ_BRANCH: Record<DeriveOnlyChain, 'single' | 'external'> = {
  bitcoin: 'single',
  evm: 'single',
  solana: 'single',
  cardano: 'external',
}

/**
 * Resolve the derive-only receive addresses **without a seed or prompt**:
 *  1. Stored row → used as-is. Cardano reads `external[0]` (discovery's primary);
 *     BTC/EVM/SOL read the `single` slot (SOL is persisted at import; BTC/EVM
 *     only if a legacy import wrote one).
 *  2. Else, for xpub-derivable chains (BTC/EVM/Cardano), rebuild the index-0
 *     receive address from the persisted account xpub via the shared generator.
 *     Nothing is written back: import persists no BTC/EVM/Cardano row, and
 *     Cardano rows are owned exclusively by discovery.
 *  3. Else flag `needsBackfill` (legacy wallet with no xpub yet; Solana, which
 *     has no public-child derivation, also lands here when its row is missing).
 *
 * Pure over the injected `store` + `getXpub` — the vault is never reachable, so
 * this path structurally cannot raise a biometric prompt.
 */
export const resolveDeriveOnlyAddresses = (params: {
  readonly store: DeriveOnlyAddressStore
  readonly groupId: string
  readonly accountIndex: number
  readonly network: Network
  readonly getXpub: AccountXpubLookup
}): Effect.Effect<ResolvedDeriveOnlyAddresses, StoreErrors> =>
  Effect.gen(function* () {
    const {store, groupId, accountIndex, network, getXpub} = params
    const out: Partial<DeriveOnlyAddresses> = {}
    let needsBackfill = false

    for (const chain of DERIVE_ONLY_CHAINS) {
      const chainId = DERIVE_ONLY_CHAIN_IDS[chain]
      const ref = refFor(groupId, accountIndex, chain)

      const row = yield* store.getAddress(ref, READ_BRANCH[chain], 0)
      if (row !== null && row.human.length > 0) {
        out[chain] = row.human
        continue
      }

      if (DERIVE_ONLY_XPUB_CHAINS.has(chain)) {
        const xpub = yield* getXpub(chainId)
        if (xpub !== null) {
          const derived = yield* createAddressGeneratorForChain(xpub, chainId, network).pipe(
            Effect.flatMap((generator) => generator.derive(0, 0)),
            Effect.map((address): string | null => address),
            Effect.catchAll((e) => {
              logger.warn('xpub derivation failed; that chain reads as absent', {
                origin: 'derive-only-addresses',
                chainId,
                error: String(e),
              })
              return Effect.succeed(null)
            }),
          )
          if (derived !== null) {
            out[chain] = derived
            continue
          }
        }
      }

      needsBackfill = true
    }

    return {addresses: out, needsBackfill}
  })
