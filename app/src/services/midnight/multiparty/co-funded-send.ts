/**
 * Several wallets on this device funding **one** Midnight payment.
 *
 * Shape C of `docs/MIDNIGHT_COFUNDING_PLAN.md`, and the Midnight counterpart to the Cardano send
 * flow's `buildCoFundedSend`. The decision half is `./cofund-plan.ts`; this is the part that opens
 * vaults and reaches the native bridge, which is why it is separate.
 *
 * ## The order is the ledger's, not a preference
 *
 * `UnshieldedOffer::well_formed` binds signature *i* to `inputs[i].owner` over `data_to_sign` of the
 * whole erased intent, and inputs sort by value and owner. So:
 *
 * 1. every contributor's inputs are gathered and the intent is **finalised**;
 * 2. each wallet signs only its own inputs;
 * 3. the composer places them by index and proves.
 *
 * ⚠️ **Nothing may be added to the intent after step 1** — the payload is the whole intent, so any
 * later edit voids every signature already gathered.
 *
 * ⚠️ **Which is why a co-funded send is sponsored, not self-funded.** A DUST action is part of the
 * intent, so attaching one after the round would invalidate it; the transaction therefore leaves here
 * proven and **unbound**, for the sponsor to fund and submit exactly as an ordinary sponsored
 * transfer does. A self-funded co-funded send needs the fee decided before signing, which is its own
 * piece of work.
 *
 * ⚠️ **Every contributor here is a wallet this device holds keys for.** Gathering a signature from
 * another device is the same three steps with a transport between 2 and 3, and needs the session id
 * this does not yet have — a device-built Midnight transaction has no hash for two parties to name.
 *
 * @module
 */

import {Roles} from '@midnight-ntwrk/wallet-sdk-hd'
import {
  type CoFundShare,
  nightPayload,
  provenTxIdentifiers,
  walletAssembleCoFundedTx,
  walletBuildCoFundedIntent,
  walletSignCoFundedShare,
} from '@pnyx/midnight-native'
import {deriveMidnightRoleKey, encodeNightAddress, parseMidnightAddress} from '@pnyx/wallet'
import {mnemonicToSeedSync} from '@scure/bip39'
import {Effect} from 'effect'

import {logger} from '../../../logger'
import {MidnightBuildError, requireCaughtUp} from '../build-failure'
import {runMidnight} from '../effect-boundary'
import {SPEND_CATCH_UP_TIMEOUT_MS, syncUnshieldedWallet} from '../wallet/unshielded'
import {unshieldedUtxoId} from '../wallet/unshielded-pending-store'
import {type CoFundSource, describeCoFundFailure, planCoFunding} from './cofund-plan'
import {nightVerifyingKey} from './owner-key'

const ORIGIN = 'midnight-cofunded-send'

/** One wallet this device can spend from, and what it is putting in. */
export type CoFundParticipant = {
  readonly groupId: string
  readonly accountIndex: number
  readonly scopeKey: string
  readonly name: string
  readonly pledge: bigint
}

export type CoFundedSendParams = {
  readonly participants: readonly CoFundParticipant[]
  /** `mn_addr…` — unshielded, because this rail has no shielded equivalent. */
  readonly recipient: string
  /** 32 bytes hex; NIGHT is 32 zero bytes. */
  readonly tokenType: string
  readonly networkId: string
  /** Absolute expiry, unix seconds. Every contributor signs over it, so it is fixed before signing. */
  readonly ttlSecs: number
  /** Opening the vault may prompt; the caller owns the prompt copy. */
  readonly biometricPrompt?: string | undefined
}

export type BuiltCoFundedSend = {
  /** A proven, **unbound** transaction — the sponsor funds the fee and submits it. */
  readonly transaction: Uint8Array
  /**
   * What each wallet put in, for the review and the record.
   *
   * ⚠️ `address` is derived from the key that **signed**, not read from the address table. It is what
   * lets the review name whose money is whose — and deriving it here is what makes it impossible for
   * the name on screen to disagree with the owner the offer attributes the inputs to.
   */
  readonly contributions: readonly {
    readonly name: string
    readonly address: string
    readonly pledge: bigint
    readonly inputs: number
    /** Which wallet on this device it is, so its inputs can be locked once the transaction goes out. */
    readonly groupId: string
    readonly accountIndex: number
    /**
     * The UTxOs this contributor spends, as `unshieldedPendingStore` names them.
     *
     * ⚠️ **Every contributor's, not just the composer's.** A co-funded send consumes inputs belonging to
     * wallets that are not the selected one and have no feed running, so without these nothing stops the
     * next build from selecting an output this transaction already spent — the node then refuses the
     * whole of it. That is the failure `unshielded-pending-store` exists to prevent, and this builder
     * predates being wired into it.
     */
    readonly consumedUtxoIds: readonly string[]
  }[]
  readonly payment: bigint
  /**
   * The transaction's identifiers — its only handle, since a device-built transaction has no hash.
   *
   * Empty when they could not be read, which is logged as an error rather than thrown: a send that went
   * out untracked is still a send. A lock recorded with none of these is simply held until its TTL.
   */
  readonly identifiers: readonly string[]
}

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Build a co-funded transfer. **Sends nothing** — the caller submits, so a throw here has put nothing
 * on chain and may be retried freely.
 */
export const buildCoFundedSend = async (params: CoFundedSendParams): Promise<BuiltCoFundedSend> => {
  const recipient = parseMidnightAddress(params.recipient)
  if (!recipient.ok || recipient.kind !== 'night') {
    throw new MidnightBuildError({
      cause: 'invalid-recipient',
      reason: 'a co-funded transfer needs an unshielded recipient address',
    })
  }

  const {createEnclaveMnemonicVault} = await import('../../credential-vault')
  const vault = createEnclaveMnemonicVault()

  // Every participant's key, before anything is built: a vault that will not open has to stop the
  // round here, not after the intent is finalised and other wallets have signed it.
  const keyed = await Promise.all(
    params.participants.map(async (participant) => {
      const mnemonic = await Effect.runPromise(vault.retrieve(participant.groupId, params.biometricPrompt))
      const seed = mnemonicToSeedSync(mnemonic)
      const nightRoleKey = await Effect.runPromise(
        deriveMidnightRoleKey(seed, Roles.NightExternal, {account: participant.accountIndex}),
      )
      // Derived from the key that will sign, and used for both the sync and the review's naming — so
      // the address the offer attributes inputs to and the one shown beside a wallet's name are one
      // value, not two reads that could disagree.
      const address = encodeNightAddress(nightPayload(nightRoleKey), params.networkId)
      // ⚠️ Each contributor is synced before the intent is finalised, not after: an input this
      // wallet has already spent elsewhere would be gathered into a round every other party then
      // signs, and the node would refuse the whole thing rather than that one contribution.
      const synced = await runMidnight(
        syncUnshieldedWallet({
          groupId: participant.groupId,
          accountIndex: participant.accountIndex,
          address,
          network: params.networkId,
          timeoutMs: SPEND_CATCH_UP_TIMEOUT_MS,
        }),
      )
      requireCaughtUp(synced.caughtUp, `${participant.name}'s contribution`, 'unshielded')
      return {participant, nightRoleKey, address, owner: nightVerifyingKey(nightRoleKey), utxos: synced.utxos}
    }),
  )

  const sources: readonly CoFundSource[] = keyed.map(({participant, owner, utxos}) => ({
    scopeKey: participant.scopeKey,
    name: participant.name,
    owner,
    utxos: utxos.filter((utxo) => utxo.tokenType === params.tokenType),
    pledge: participant.pledge,
  }))
  const plan = planCoFunding(sources)
  if (!plan.ok) {
    throw new MidnightBuildError({cause: 'insufficient-funds', reason: describeCoFundFailure(plan.failure)})
  }

  // ── 1. finalise ─────────────────────────────────────────────────────────────────────────────
  const intent = await walletBuildCoFundedIntent({
    contributions: plan.contributions.map((contribution) => ({
      owner: contribution.owner,
      contributes: contribution.pledge,
      inputs: contribution.inputs.map((utxo) => ({
        value: utxo.value,
        tokenType: hexToBytes(utxo.tokenType),
        intentHash: hexToBytes(utxo.intentHash),
        outputIndex: utxo.outputIndex,
      })),
    })),
    recipientAddress: recipient.payload,
    tokenType: hexToBytes(params.tokenType),
    networkId: params.networkId,
    ttlSecs: params.ttlSecs,
  })

  // ── 2. each wallet signs its own ────────────────────────────────────────────────────────────
  const shares: CoFundShare[] = []
  for (const {participant, nightRoleKey} of keyed) {
    const own = await walletSignCoFundedShare({intent, nightRoleKey})
    if (own.length === 0) {
      // Its inputs are in the offer, so signing none of them means the owner it was attributed under
      // is not the key it holds — a mismatch worth naming here rather than as a verification failure
      // three steps later.
      throw new MidnightBuildError({
        cause: 'malformed-input',
        reason: `${participant.name} owns none of the inputs attributed to it`,
      })
    }
    shares.push(...own)
  }

  // ── 3. assemble ─────────────────────────────────────────────────────────────────────────────
  const transaction = await walletAssembleCoFundedTx({intent, shares, networkId: params.networkId})

  logger.info('a co-funded transfer was built', {
    origin: ORIGIN,
    network: params.networkId,
    contributors: plan.contributions.length,
    payment: plan.payment.toString(),
    inputs: shares.length,
    bytes: transaction.length,
  })

  // Read before anything is handed on: this is what lets a lock be released the moment the chain
  // accounts for the transaction, instead of being held for the whole TTL.
  let identifiers: readonly string[] = []
  try {
    identifiers = await provenTxIdentifiers(transaction)
  } catch (error) {
    logger.error('could not read a co-funded transfer’s identifiers; its locks will be held to their TTL', {
      origin: ORIGIN,
      bytes: transaction.length,
      error: String(error),
    })
  }

  const addressByScope = new Map(keyed.map(({participant, address}) => [participant.scopeKey, address]))
  const walletByScope = new Map(keyed.map(({participant}) => [participant.scopeKey, participant]))
  return {
    transaction,
    contributions: plan.contributions.map((contribution) => {
      // Every planned contribution came from a keyed participant, so both lookups are present by
      // construction — an empty address would be a wallet the review could not name, and a missing
      // wallet would be inputs nothing could lock.
      const wallet = walletByScope.get(contribution.scopeKey)
      if (wallet === undefined) {
        throw new MidnightBuildError({
          cause: 'malformed-input',
          reason: `${contribution.name} was planned from a scope no participant holds`,
        })
      }
      return {
        name: contribution.name,
        address: addressByScope.get(contribution.scopeKey) ?? '',
        pledge: contribution.pledge,
        inputs: contribution.inputs.length,
        groupId: wallet.groupId,
        accountIndex: wallet.accountIndex,
        consumedUtxoIds: contribution.inputs.map(unshieldedUtxoId),
      }
    }),
    payment: plan.payment,
    identifiers,
  }
}
