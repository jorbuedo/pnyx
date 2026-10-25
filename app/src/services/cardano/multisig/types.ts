/**
 * The persisted shape of a CIP-1854 shared wallet.
 *
 * Kept free of logic so `derive.ts` and `model.ts` can both depend on it without
 * a cycle.
 *
 * @module
 */

import type {XpubHex} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import type {CoSignerTag, ScriptTemplate} from './template'

/**
 * The address-network byte for a rail network name.
 *
 * Pure and taking the name as an argument, so it never reaches back into the
 * config module that the multisig barrel is itself re-exported alongside.
 */
export const addressNetworkOf = (network: string): Address.Network =>
  network === 'mainnet' ? Address.Network.Mainnet : Address.Network.Testnet

/**
 * One participant: the tag the templates reference, and the CIP-1854 account
 * public key every one of their keys derives from.
 *
 * The xpub — not a key hash — is what CIP-1854 says co-signers exchange, and it
 * is what lets each index produce a fresh address. A roster of hashes pins the
 * wallet to a single address and cannot be reproduced by other wallet software.
 */
export type CoSignerRef = {
  readonly tag: CoSignerTag
  readonly name: string
  /** CIP-1854 level-3 account xpub: 32-byte public key ‖ 32-byte chain code, hex. */
  readonly accountXpubHex: XpubHex
  /** True for the co-signer that is THIS wallet, so the UI can mark "(You)". */
  readonly isSelf?: boolean
}

/**
 * A shared wallet: who can sign, under what rule, on which network.
 *
 * Addresses are *not* stored — they are derived per index from the templates and
 * the roster (see `derive.ts`). Storing one would reintroduce the single-address
 * model the templates exist to replace.
 */
export type SharedWallet = {
  /** Stable local id; also the storage key suffix. */
  readonly id: string
  readonly name: string
  readonly coSigners: readonly CoSignerRef[]
  /** Spending rule, over payment (role 0) keys. */
  readonly paymentTemplate: ScriptTemplate
  /** Staking rule, over stake (role 2) keys. Usually structurally identical to payment. */
  readonly delegationTemplate: ScriptTemplate
  readonly network: Address.Network
  /** The CIP-1854 account index every co-signer's xpub was taken at. */
  readonly accountIndex: number
  /**
   * The local wallet group whose seed backs our co-signer key.
   *
   * A shared wallet holds no credential of its own — when we sign, we sign with
   * the wallet that contributed our xpub. Absent when the roster does not
   * include us, which is a wallet we can watch but never witness for.
   */
  readonly selfGroupId?: string
  readonly createdAt: string
  /**
   * CIP-146 on-chain registration.
   *
   * A freshly created shared wallet holds nothing, so it cannot pay for its own
   * registration — the transaction is funded by whichever co-signer publishes
   * it. The intent is therefore recorded at creation and settled later, and
   * `'pending'` means "asked for, not yet on chain", never "probably fine".
   */
  readonly registration?: SharedWalletRegistrationState
}

export type SharedWalletRegistrationState =
  | {readonly status: 'skipped'}
  | {readonly status: 'pending'}
  | {readonly status: 'published'; readonly txHash: string}

/** CIP-1854 roles. Role 1 is unused for multisig. */
export const MULTISIG_PAYMENT_ROLE = 0
export const MULTISIG_STAKE_ROLE = 2

/**
 * Stake keys are pinned at index 0 — `accXPub/2/0`, per CIP-1854 and
 * cardano-wallet. Only payment keys rotate.
 */
export const STAKE_INDEX = 0

/**
 * How many consecutive unused payment indexes a wallet keeps derived. CIP-1854
 * says "always provide up-to 20 consecutive unused multisig keys"; discovery
 * stops after this many empty addresses in a row.
 */
export const MULTISIG_ADDRESS_GAP = 20
