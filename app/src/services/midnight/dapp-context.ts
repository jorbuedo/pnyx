/**
 * The data source behind the Midnight dApp connector.
 *
 * Every read here is served from storage or an endpoint the app already talks to — **none of it needs
 * key material**, so a page asking for an address or a balance never puts a biometric prompt in the
 * user's way. That is what makes the connector's read surface answerable at all:
 *
 * - the three addresses are persisted at wallet creation in fixed slots (night 0, dust 1, shielded 2),
 *   because Midnight addresses derive from role *secret* keys and cannot be re-derived from an xpub;
 * - the shielded coin and encryption public keys are **decoded from the stored shielded address**
 *   rather than re-derived, which is why no seed is involved;
 * - unshielded balances come from the UTxO cache the balance hook already fills;
 * - shielded balances come from the locally synced Zswap state, which is a file read, not a network
 *   call — and its absence is reported rather than answered as an empty wallet;
 * - DUST comes from the indexer's `dustGenerationStatus`, so it needs no dust sync.
 *
 * The exception is proving (`getProvingProvider`), which is not a read of anything: a dApp's circuit
 * arrives with the request and this device produces the proof. It is threaded in as a dep like the
 * rest, which is also what keeps this module loadable outside a device. See `dapp-proving.ts`.
 *
 * ⚠️ **Absence is reported, never substituted.** A missing address, an unconfigured node URL or a DUST
 * read that failed answers with a wire error. A dApp that receives an error can ask the user to fix
 * something; one that receives `""` or `0` will act on it.
 *
 * @module
 */

import {
  ApiErrorCode,
  historyEntriesOf,
  type MidnightErrorCode,
  type MidnightHandlerContext,
  type WalletTransaction,
  WireError,
} from '@pnyx/dapp-connector'
import {encodeShieldedCoinPublicKey, encodeShieldedEncryptionPublicKey, parseMidnightAddress} from '@pnyx/wallet'
import {Effect} from 'effect'
import {logger} from '../../logger'
import {fetchDustGenerationStatus} from '../midnight-dust/indexer'
import {buildFailureApiCode, describeBuildFailure, MidnightBuildError} from './build-failure'
import {midnightIndexerFor, midnightNodeFor} from './networks'
import type {MidnightActivity} from './wallet/midnight-activity'
import {indexerWsUrl} from './wallet/unshielded-sync'

const ORIGIN = 'midnight-dapp-context'

/** Slots the wallet writes its Midnight addresses into. Fixed at creation; `addressIndex` selects one. */
/** Address slots on the Midnight side. Exported so callers cannot re-invent the index as a literal. */
export const SLOT = {night: 0, dust: 1, shielded: 2} as const

/**
 * A wire error carrying the Midnight code beside the CIP-30 number.
 *
 * ⚠️ **Every failure here used to be `InternalError`** — "no address stored", "no DUST designated",
 * "the node URL is unset", all the same code. A page cannot act on that: it cannot tell a wallet that
 * is misconfigured from one that is simply not ready from a request it got wrong. The two vocabularies
 * are different sizes, so the number stays the coarse one a Cardano-shaped page understands while
 * `apiCode` carries the detail.
 */
const wire = (message: string, apiCode: MidnightErrorCode = 'InternalError'): WireError =>
  new WireError({
    code: apiCode === 'InvalidRequest' ? ApiErrorCode.InvalidRequest : ApiErrorCode.InternalError,
    message,
    apiCode,
  })

/**
 * Report the reason rather than a shape a dApp would mistake for data.
 *
 * A `WireError` thrown inside `read` is passed through untouched — that is how a handler names its own
 * code for a failure it understands, instead of having this wrapper flatten it.
 */
const failing = <A>(what: string, read: () => Promise<A>): Effect.Effect<A, WireError> =>
  Effect.tryPromise({
    try: read,
    catch: (error) => {
      if (error instanceof WireError) return error
      logger.warn('a connector read could not be served', {origin: ORIGIN, what, error: String(error)})
      const cause = error instanceof MidnightBuildError ? buildFailureApiCode(error.cause) : 'InternalError'
      return wire(`${what} is unavailable: ${describeBuildFailure(error)}`, cause)
    },
  })

/**
 * Split a stored `mn_shield-addr` into the three strings the API asks for.
 *
 * ⚠️ **Uses this repo's own bech32m codec, not `@midnight-ntwrk/wallet-sdk-address-format`.** That
 * package imports `ledger-v8`, which cannot be bundled for React Native at all — its declared RN entry
 * does not exist and Hermes has no WASM. Importing it type-checked and unit-tested clean (vitest runs in
 * Node) and broke the Metro bundle outright. Nothing in the app may reach for it.
 *
 * The component keys are *in* the address: a shielded payload is `coinPublicKey(32) ‖
 * encryptionPublicKey(32)`, so this splits rather than re-derives — a re-derivation could disagree with
 * the address the wallet has been handing out, and would need the seed.
 *
 * All three are Bech32m, as the API states. The network comes from the address itself, which is the
 * authority on its own network.
 */
export const shieldedAddressParts = (
  address: string,
): {shieldedAddress: string; shieldedCoinPublicKey: string; shieldedEncryptionPublicKey: string} => {
  const parsed = parseMidnightAddress(address)
  if (!parsed.ok) throw wire(`not a readable Midnight address: ${parsed.reason}`)
  if (parsed.kind !== 'shielded') throw wire(`expected a shielded address, got a ${parsed.kind} one`)
  if (parsed.payload.length !== 64) {
    throw wire(`a shielded payload is 64 bytes, got ${parsed.payload.length}`)
  }
  return {
    shieldedAddress: address,
    shieldedCoinPublicKey: encodeShieldedCoinPublicKey(parsed.payload.slice(0, 32), parsed.network),
    shieldedEncryptionPublicKey: encodeShieldedEncryptionPublicKey(parsed.payload.slice(32), parsed.network),
  }
}

/** What the host must supply. Kept narrow so the context is testable without a wallet or a provider. */
export type MidnightContextDeps = {
  /** `getReceiveAddress`, with `addressIndex` selecting the slot. */
  readonly receiveAddress: (addressIndex: number) => Promise<string>
  /**
   * Atomic balances per token type from the unshielded UTxO cache held for `address`, or `null` when
   * no cache belongs to it.
   *
   * ⚠️ **`address` is an argument, not a closure, because the cache is not keyed by network.** One blob
   * serves all three chains (`wallet/unshielded-store.ts`), so a wallet that has not been opened since a
   * network switch still holds the previous chain's UTxOs. A Midnight address carries its network in the
   * HRP, so passing it is what tells the two apart — and taking it here means a caller cannot forget.
   *
   * `null` and an empty map are different answers: nobody has looked on this network, versus looked and
   * found nothing.
   */
  readonly unshieldedTotals: (address: string) => Promise<ReadonlyMap<string, bigint> | null>
  /**
   * Shielded balances per token type from the synced Zswap state, or `null` when no state exists.
   *
   * `null` and an empty map are different answers: never synced, versus synced and holding nothing.
   */
  readonly shieldedTotals: () => Promise<ReadonlyMap<string, bigint> | null>
  /** The activity rows the wallet holds for `address`, newest first. See {@link unshieldedTotals}. */
  readonly activity: (address: string) => Promise<readonly MidnightActivity[]>
  /** The Cardano reward addresses whose DUST generation this wallet is asking about. */
  readonly rewardAddresses: () => Promise<readonly string[]>
  /**
   * The wallet's own spendable DUST, or `null` when it has never been synced.
   *
   * ⚠️ **Not the generation registration.** This used to read
   * `fetchDustGenerationStatus(rewardAddress)` — the *Cardano-side* registration's capacities from the
   * indexer — and answer them as the balance. Those are a different fact: a wallet holding spendable
   * DUST reads `0` there whenever the registration row does, so every dApp asking whether it could pay
   * a Midnight fee was told no. The wallet's DUST lives in its synced DUST state, which is what the
   * app's own DUST screen reads.
   *
   * `null` for never-synced is the same distinction `shieldedTotals` makes: nobody has looked yet is
   * not zero.
   */
  readonly spendableDust: () => Promise<bigint | null>
  /** The Midnight *funds* network this wallet is on, e.g. `preprod`. */
  readonly network: string
  /**
   * Check a dApp's proof preimage against its circuit.
   *
   * A dep rather than a direct import for a mechanical reason worth stating: the proving rail reaches
   * `@pnyx/midnight-native`, which pulls `expo-modules-core`, which cannot load under vitest — and this
   * module is deliberately testable in Node. Every other capability here is threaded the same way.
   */
  readonly checkPreimage: (zkir: Uint8Array, preimage: Uint8Array) => Promise<(number | undefined)[]>
  /** Prove a dApp's circuit on this device. Seconds of CPU; see `dapp-proving.ts`. */
  readonly proveCircuit: (params: {
    readonly digest: string
    readonly zkir?: Uint8Array
    readonly proverKey?: Uint8Array
    readonly verifierKey?: Uint8Array
    readonly preimage: Uint8Array
    readonly bindingInput?: Uint8Array
  }) => Promise<Uint8Array>
}

/** Assemble the connector's view of this wallet. */
export const createMidnightHandlerContext = (deps: MidnightContextDeps): MidnightHandlerContext => ({
  unshieldedAddress: failing('the unshielded address', () => deps.receiveAddress(SLOT.night)),

  dustAddress: failing('the DUST address', () => deps.receiveAddress(SLOT.dust)),

  shieldedAddresses: failing('the shielded address', async () =>
    shieldedAddressParts(await deps.receiveAddress(SLOT.shielded)),
  ),

  unshieldedBalances: failing('unshielded balances', async () => {
    const totals = await deps.unshieldedTotals(await deps.receiveAddress(SLOT.night))
    // Same rule as the shielded side below: an empty record claims this wallet holds nothing, and an
    // absent cache does not say that. Before this asked by address it could answer with *another
    // network's* balance, which is the worse half of the same bug.
    if (totals === null)
      throw wire('this wallet has no synced unshielded state on this network, so its balance is unknown')
    return Object.fromEntries(totals)
  }),

  shieldedBalances: failing('shielded balances', async () => {
    const totals = await deps.shieldedTotals()
    // An empty record would say "this wallet holds no shielded tokens", which is not what an absent
    // state means — nobody has looked yet. The same rule the balance hook states for the UI.
    // Not ready, not broken and not the page's fault. `InternalError` is the honest code — there is no
    // "ask again later" in the union — but the message says which, so a dApp can tell its user.
    if (totals === null) throw wire('this wallet has no synced shielded state, so its balance is unknown')
    return Object.fromEntries(totals)
  }),

  dustBalance: failing('the DUST balance', async () => {
    // ⚠️ **`balance` is what this wallet can spend; `cap` is what its NIGHT generates towards.** Two
    // sources, because they are two facts. `balance` used to be read from the *generation registration*
    // too, which reports `0` whenever that Cardano-side row does — so a wallet holding spendable DUST
    // told every dApp it had none, and the sponsor fallback looked like the only option.
    const balance = await deps.spendableDust()
    // Never synced is not zero, and a dApp deciding whether it can pay a fee must not read it as zero.
    // `InternalError` is the honest code — there is no "ask again later" in the union — but the message
    // says which, exactly as the shielded balance does.
    if (balance === null) throw wire('this wallet has no synced DUST state, so its balance is unknown')

    const [rewardAddress] = await deps.rewardAddresses()
    if (rewardAddress === undefined) {
      // No designation means no generation, so there is no ceiling to report — but the balance above is
      // still real, so this is the one field that goes missing rather than the whole answer.
      return {balance, cap: null}
    }
    const snapshot = await Effect.runPromise(fetchDustGenerationStatus(rewardAddress, deps.network))
    // The three snapshot kinds are three different facts: `none` means no live registration,
    // `unavailable` means we could not look. Neither is a cap of zero.
    const cap =
      snapshot.kind === 'ok' && snapshot.row.maxCapacity !== undefined ? BigInt(snapshot.row.maxCapacity) : null
    return {balance, cap}
  }),

  // Proving is the one connector capability that is not a read at all: the circuit arrives with the
  // request and this device is the prover.
  checkPreimage: (zkir, preimage) => failing('the preimage check', () => deps.checkPreimage(zkir, preimage)),

  proveCircuit: (params) => failing('proving', () => deps.proveCircuit(params)),

  configuration: failing('the configuration', async () => {
    const indexerUri = midnightIndexerFor(deps.network)
    const substrateNodeUri = midnightNodeFor(deps.network)
    // Both are required fields. A dApp uses `networkId` to check it is talking to the chain it meant,
    // so a guessed endpoint would defeat the one check the field exists for.
    if (indexerUri === null) throw wire(`no indexer configured for ${deps.network}`)
    if (substrateNodeUri === null) {
      throw wire(`no substrate node configured for ${deps.network}`)
    }
    return {indexerUri, indexerWsUri: indexerWsUrl(indexerUri), substrateNodeUri, networkId: deps.network}
  }),

  connectionStatus: Effect.sync(() => ({status: 'connected' as const, networkId: deps.network})),

  txHistory: (pageNumber, pageSize) =>
    failing('transaction history', async () => {
      const rows = await deps.activity(await deps.receiveAddress(SLOT.night))
      const described = historyEntriesOf(rows.map(asWalletTransaction), (reason) =>
        // A shorter page is indistinguishable from a shorter history unless we say so.
        logger.debug('a transaction was left out of connector history', {origin: ORIGIN, reason}),
      )
      const from = (pageNumber - 1) * pageSize
      return described.slice(from, from + pageSize)
    }),

  hintUsage: (methods) =>
    Effect.sync(() => {
      // Advisory: the API promises a dApp nothing here, so recording it is enough until there is
      // something worth warming.
      logger.debug('a dApp hinted which connector methods it will use', {origin: ORIGIN, methods: [...methods]})
    }),
})

/** An activity row in the terms the status mapping needs. */
const asWalletTransaction = (row: MidnightActivity): WalletTransaction => ({
  hash: row.pending === true ? null : row.hash,
  pending: row.pending === true,
  // The wallet drops an abandoned send rather than keeping it, so a row here is never abandoned.
  abandoned: false,
  ...(row.outcome === undefined ? {} : {outcome: row.outcome}),
})
