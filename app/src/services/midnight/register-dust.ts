/**
 * Registering this wallet's NIGHT on Midnight for DUST generation.
 *
 * ⚠️ **The other DUST registration is a different thing.** `screens/cardano/dust` registers **cNIGHT
 * held on Cardano** — a Cardano transaction, mainnet only. This registers the **Midnight** night key,
 * which is a Midnight transaction, and it is the route preprod uses. The DUST that results is the same
 * DUST either way.
 *
 * The cheap half of the rail: a registration is a signed declaration, not a circuit, so there are no
 * artifacts to fetch and no proving time. It also funds itself — the ledger credits
 * `allow_fee_payment` to the DUST balance, so the registration authorises its own fee out of the DUST
 * its NIGHT projects to generate. That is what lets a wallet holding no DUST get any, and it means
 * neither a sponsor nor a synced DUST state is needed.
 *
 * ⚠️ **It does need a fresh unshielded sync.** The allowance is backed only by NIGHT this transaction
 * spends, so the registration has to name real, unspent outputs — see `./registration-inputs.ts` for
 * which ones and why there are at most four.
 *
 * ⚠️ **It comes back sealed, so it is submitted directly rather than through the sponsor.** Every other
 * transaction this app builds goes out unbound for the sponsor to bind; this one is complete, and
 * `./submit-sealed.ts` is the door it goes through.
 *
 * @module
 */

import {Roles} from '@midnight-ntwrk/wallet-sdk-hd'
import {hex} from '@pnyx/crypto'
import {type DustRegistrationTx, dustRegister, nightPayload} from '@pnyx/midnight-native'
import {deriveMidnightRoleKey, encodeNightAddress} from '@pnyx/wallet'
import {mnemonicToSeedSync} from '@scure/bip39'
import {Effect} from 'effect'

import {logger} from '../../logger'
import {runMidnight} from './effect-boundary'
import {registrationInputs} from './registration-inputs'
import {submitSealedTransaction} from './submit-sealed'
import {rememberSyncKeysForScheduler} from './sync-keys'
import {SPEND_CATCH_UP_TIMEOUT_MS, syncUnshieldedWallet} from './wallet/unshielded'
import {addUnshieldedLock, unshieldedUtxoId} from './wallet/unshielded-pending-store'

const ORIGIN = 'midnight-register-dust'

/** An hour. Far-future TTLs are rejected at submission as `Custom error: 182`, which names nothing. */
const TTL_SECONDS = 3600

export type RegisterDustParams = {
  readonly groupId: string
  readonly accountIndex: number
  /** The Midnight funds network, e.g. `preprod`. */
  readonly networkId: string
  /** `false` deregisters — the same transaction with the binding removed. */
  readonly register: boolean
  /** Localized biometric-prompt title — the vault needs one. */
  readonly biometricPrompt: string
}

/**
 * Build a sealed registration for this wallet's Midnight NIGHT.
 *
 * Returns the transaction and the DUST it authorised; **submitting is a separate step**
 * ({@link registerDust}), so a caller that wants to show the user what it authorises before sending
 * can.
 *
 * Throws with a stated reason rather than returning a partial result: a registration nobody can submit
 * is not a smaller success.
 */
/** A built registration, plus what the submit needs to lock the NIGHT it spends. */
export type BuiltDustRegistration = DustRegistrationTx & {
  /** `intentHash:outputIndex` of the NIGHT it spends back to itself. */
  readonly consumedUtxoIds: readonly string[]
  /** Unix seconds it stops being acceptable — its own TTL, and what the lock expires on. */
  readonly expiresAt: number
}

export const buildDustRegistration = async (params: RegisterDustParams): Promise<BuiltDustRegistration> => {
  const {createEnclaveMnemonicVault} = await import('../credential-vault')
  const mnemonic = await Effect.runPromise(
    createEnclaveMnemonicVault().retrieve(params.groupId, params.biometricPrompt),
  )
  const seed = mnemonicToSeedSync(mnemonic)
  // The vault has just been unlocked, so the scheduler can be handed what it needs to keep DUST
  // current afterwards without asking again. See `rememberSyncKeysForScheduler`.
  void rememberSyncKeysForScheduler(params.groupId, params.accountIndex, mnemonic, params.networkId)
  const [nightRoleKey, dustRoleKey] = await Promise.all([
    Effect.runPromise(deriveMidnightRoleKey(seed, Roles.NightExternal, {account: params.accountIndex})),
    Effect.runPromise(deriveMidnightRoleKey(seed, Roles.Dust, {account: params.accountIndex})),
  ])

  // Through the caching path, not `syncUnshielded` directly: that one replays from transaction 0 and
  // discards what it learned, so a send left the cache at its stalest exactly when someone was most
  // likely looking at it. One writer also means one place for the spendable overlay to attach.
  const synced = await runMidnight(
    syncUnshieldedWallet({
      groupId: params.groupId,
      accountIndex: params.accountIndex,
      address: encodeNightAddress(nightPayload(nightRoleKey), params.networkId),
      network: params.networkId,
      timeoutMs: SPEND_CATCH_UP_TIMEOUT_MS,
    }),
  )
  if (!synced.caughtUp) {
    // Same class of lie as the refusal below, and it has to be checked first: from a half-replayed set
    // `registrationInputs` finds nothing and we would tell the user they hold no NIGHT when it has
    // simply not been counted. A plain `Error` and not `requireCaughtUp`'s `MidnightBuildError`, because
    // `DustRegistrationScreen` renders `error.message` verbatim and a `Data.TaggedError` carries its
    // text in `reason` — it would show a blank note.
    throw new Error('This wallet is still syncing its NIGHT outputs — try the registration again shortly.')
  }
  const inputs = params.register ? registrationInputs(synced.utxos) : []
  if (params.register && inputs.length === 0) {
    // Not a silent empty: an offerless registration builds and then fails at the node with
    // `InsufficientDustForRegistrationFee`, which reads as a chain problem rather than this one.
    // Not a build failure in the shared sense: the wallet is not short of funds and nothing is
    // malformed — every output it holds is already doing this. Left as a plain refusal with copy the
    // screen shows verbatim, rather than stretched into a cause no caller branches on.
    throw new Error('This wallet has no NIGHT left to register — every output it holds is already generating DUST.')
  }

  const now = Math.floor(Date.now() / 1000)
  const built = await dustRegister({
    nightRoleKey,
    dustRoleKey,
    register: params.register,
    networkId: params.networkId,
    ttlSecs: now + TTL_SECONDS,
    ctimeSecs: now,
    nightInputs: inputs.map((utxo) => ({
      value: utxo.value,
      tokenType: decodeHex(utxo.tokenType, 'token type'),
      intentHash: decodeHex(utxo.intentHash, 'intent hash'),
      outputIndex: utxo.outputIndex,
    })),
  })
  logger.info('a dust registration was built', {
    origin: ORIGIN,
    register: params.register,
    network: params.networkId,
    bytes: built.transaction.length,
    inputs: inputs.length,
    backingNight: inputs.reduce((total, u) => total + u.value, 0n).toString(),
    allowFeePayment: built.allowFeePayment.toString(),
  })
  return {...built, consumedUtxoIds: inputs.map(unshieldedUtxoId), expiresAt: now + TTL_SECONDS}
}

/** Indexer hex, or a named failure. Never a zero-filled fallback: that would spend the wrong output. */
const decodeHex = (text: string, what: string): Uint8Array => {
  const decoded = hex.decode(text)
  if (decoded._tag === 'Left') throw new Error(`${what} is not hex: ${text}`)
  return decoded.right
}

/** A registration the chain accepted. */
export type SubmittedDustRegistration = {
  /** The DUST the registration authorised itself to spend on its own fee. */
  readonly allowFeePayment: bigint
  /** blake2-256 of the submitted extrinsic — see `./submit-sealed.ts` on why this one has a hash. */
  readonly extrinsicHash: string
  /** Size of the sealed transaction, before its substrate framing. */
  readonly bytes: number
}

/**
 * Build a registration and submit it.
 *
 * Two steps rather than one function because they fail differently and a caller has to tell them
 * apart: a build failure is this wallet's (no vault, no key, a network id the ledger refuses), and a
 * submit failure is the chain's. Both are thrown, neither is swallowed, and nothing partial is
 * returned — a registration that built but did not submit has changed nothing on chain, so reporting
 * it as any kind of success would be the lie the build-only button was written to avoid.
 */
export const registerDust = async (params: RegisterDustParams): Promise<SubmittedDustRegistration> => {
  const built = await buildDustRegistration(params)
  const {extrinsicHash} = await runMidnight(
    submitSealedTransaction({
      transaction: built.transaction,
      network: params.networkId,
    }),
  )
  // A registration spends NIGHT like any transfer, so its inputs are locked the same way — otherwise a
  // send issued right after it would select the outputs it just consumed.
  if (built.consumedUtxoIds.length > 0) {
    await runMidnight(
      addUnshieldedLock(params.groupId, params.accountIndex, {
        consumedUtxoIds: built.consumedUtxoIds,
        expiresAt: built.expiresAt,
        identifiers: [],
      }),
    )
  }
  logger.info('a dust registration was submitted', {
    origin: ORIGIN,
    register: params.register,
    network: params.networkId,
    extrinsicHash,
  })
  return {allowFeePayment: built.allowFeePayment, extrinsicHash, bytes: built.transaction.length}
}
