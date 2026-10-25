/**
 * Funding a transaction a dApp composed — the host half of the connector's
 * `balanceUnsealedTransaction`.
 *
 * Two entry points, deliberately split by whether a key is involved:
 *
 * - {@link readTxDeficits} needs no key and no vault. It exists so the review screen can name what a
 *   request costs **before** anyone is asked to approve it; asking for biometrics to find out what a
 *   page wants would be asking for approval of an unnamed amount.
 * - {@link fundDappTransaction} opens the vault, derives the Night role key, and signs. The seed leaves
 *   scope with the function, as in `./build-transfer.ts`.
 *
 * ⚠️ **Funding is not sending.** This returns a funded, signed, still-unbound transaction and submits
 * nothing. The page decides whether to submit it, and may never do so.
 *
 * @module
 */

import {Roles} from '@midnight-ntwrk/wallet-sdk-hd'
import {hex} from '@pnyx/crypto'
import {
  deficitsOf,
  nightPayload,
  type TxDeficit,
  txBalance,
  walletBalanceUnsealedTransaction,
} from '@pnyx/midnight-native'
import {deriveMidnightRoleKey, encodeNightAddress} from '@pnyx/wallet'
import {mnemonicToSeedSync} from '@scure/bip39'
import {Effect} from 'effect'
import {logger} from '../../logger'
import {MidnightBuildError, requireCaughtUp} from './build-failure'
import {runMidnight} from './effect-boundary'
import {fundingCandidatesFor} from './fund-candidates'
import {rememberSyncKeysForScheduler} from './sync-keys'
import {SPEND_CATCH_UP_TIMEOUT_MS, syncUnshieldedWallet} from './wallet/unshielded'
import type {UnshieldedUtxo} from './wallet/unshielded-utxo-set'

const ORIGIN = 'midnight-fund-transaction'

/**
 * What a dApp's transaction owes, straight from the ledger.
 *
 * Reads the transaction and nothing else — no wallet state, no key, no network call. A failure here is
 * a transaction we cannot parse, which is worth surfacing as such rather than as an empty deficit list:
 * "owes nothing" and "could not be read" are different facts and only one of them is approvable.
 */
export const readTxDeficits = async (transaction: Uint8Array): Promise<readonly TxDeficit[]> => {
  const entries = await txBalance(transaction)
  const deficits = deficitsOf(entries)
  logger.debug('read what a dApp transaction owes', {
    origin: ORIGIN,
    bytes: transaction.length,
    entries: entries.length,
    deficits: deficits.length,
  })
  return deficits
}

export type FundTransactionParams = {
  readonly groupId: string
  readonly accountIndex: number
  /** The dApp's `Transaction<SignatureEnabled, Proof, PreBinding>`. */
  readonly transaction: Uint8Array
  readonly deficits: readonly TxDeficit[]
  /** The Midnight funds network, e.g. `preprod`. */
  readonly networkId: string
  /** Localized biometric-prompt title — the vault needs one. */
  readonly biometricPrompt: string
}

/** Our own unshielded address, for the UTxO query. Derived rather than read, so it matches the key. */
const ourUnshieldedAddress = (nightRoleKey: Uint8Array, networkId: string): string =>
  encodeNightAddress(nightPayload(nightRoleKey), networkId)

/**
 * Fund every unshielded deficit and sign the intents that changed.
 *
 * Throws with a stated reason: a deficit this wallet cannot cover (naming which of the two reasons), or
 * a native refusal (a shielded deficit, a guaranteed-segment deficit, an intent that already spends).
 * None of them is a silent no-op — each means the transaction the user just approved does not exist.
 */
export const fundDappTransaction = async (params: FundTransactionParams): Promise<Uint8Array> => {
  const {createEnclaveMnemonicVault} = await import('../credential-vault')
  const mnemonic = await Effect.runPromise(
    createEnclaveMnemonicVault().retrieve(params.groupId, params.biometricPrompt),
  )
  const seed = mnemonicToSeedSync(mnemonic)
  // The vault has just been unlocked, so the scheduler can be handed what it needs to keep DUST
  // current afterwards without asking again. See `rememberSyncKeysForScheduler`.
  void rememberSyncKeysForScheduler(params.groupId, params.accountIndex, mnemonic, params.networkId)
  const nightRoleKey = await Effect.runPromise(
    deriveMidnightRoleKey(seed, Roles.NightExternal, {account: params.accountIndex}),
  )

  // Through the caching path, not `syncUnshielded` directly: that one replays from transaction 0 and
  // discards what it learned, so a send left the cache at its stalest exactly when someone was most
  // likely looking at it. One writer also means one place for the spendable overlay to attach.
  const synced = await runMidnight(
    syncUnshieldedWallet({
      groupId: params.groupId,
      accountIndex: params.accountIndex,
      address: ourUnshieldedAddress(nightRoleKey, params.networkId),
      network: params.networkId,
      timeoutMs: SPEND_CATCH_UP_TIMEOUT_MS,
    }),
  )
  requireCaughtUp(synced.caughtUp, "a funding offer for the page's transaction", 'unshielded')
  const utxos: readonly UnshieldedUtxo[] = synced.utxos

  const offer = fundingCandidatesFor(utxos, params.deficits)
  if (!offer.ok) {
    const {tokenType, owed, held, reason} = offer.shortfall
    logger.warn('a dApp transaction cannot be funded from this wallet', {
      origin: ORIGIN,
      tokenType,
      owed: owed.toString(),
      held: held.toString(),
      reason,
      utxos: utxos.length,
    })
    // ⚠️ Two different facts, and the connector spec distinguishes them. Not enough funds is
    // `InsufficientFunds` — "the request is well-formed but cannot be fulfilled". Too many inputs is
    // not: the wallet *has* the money, it is spread across more outputs than one transaction can take.
    throw new MidnightBuildError({
      cause: reason === 'too-many-inputs' ? 'too-many-inputs' : 'insufficient-funds',
      reason:
        reason === 'too-many-inputs'
          ? 'this amount is spread across too many outputs for one Midnight transaction — consolidate first'
          : 'not enough unshielded funds to cover what this transaction owes',
    })
  }

  const funded = await walletBalanceUnsealedTransaction({
    transaction: params.transaction,
    nightRoleKey,
    candidates: offer.candidates.map((utxo) => ({
      value: utxo.value,
      tokenType: decodeHex(utxo.tokenType, 'token type'),
      intentHash: decodeHex(utxo.intentHash, 'intent hash'),
      outputIndex: utxo.outputIndex,
    })),
  })
  logger.info('a dApp transaction was funded', {
    origin: ORIGIN,
    was: params.transaction.length,
    now: funded.length,
    offered: offer.candidates.length,
    network: params.networkId,
  })
  return funded
}

/** Indexer hex, or a named failure. Never a zero-filled fallback: that would spend the wrong output. */
const decodeHex = (text: string, what: string): Uint8Array => {
  const decoded = hex.decode(text)
  if (decoded._tag === 'Left') {
    throw new MidnightBuildError({cause: 'malformed-input', reason: `${what} is not hex: ${text}`})
  }
  return decoded.right
}
