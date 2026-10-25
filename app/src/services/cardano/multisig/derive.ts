/**
 * Seedless derivation for a CIP-1854 shared wallet: account xpubs → per-index
 * key hashes → native scripts → addresses.
 *
 * Everything here runs off public keys via CKDpub (`Keys.derivePublicPath`), so
 * deriving an address never touches a seed and never needs a biometric ceremony.
 * That is what makes it correct to hold only co-signers' xpubs.
 *
 * **The index is shared.** CIP-1854: "when deriving new keys, the same indexes
 * must be used for all account involved in the template", so index `i` selects
 * key `i` from *every* co-signer. Mixing indexes would produce an address no
 * other participant's wallet derives.
 *
 * @module
 */

import type {Bech32, KeyHashHex, ScriptHex, XpubHex} from '@evolution-sdk/review/Brands'
import {Address, Keys, Scripts} from '@pnyx/cardano-core'
import type {CoreError} from '@pnyx/cardano-core/Op'
import {Effect} from 'effect'
import type {ScriptTemplate} from './template'
import {type CoSignerRef, MULTISIG_PAYMENT_ROLE, MULTISIG_STAKE_ROLE, type SharedWallet, STAKE_INDEX} from './types'

/** blake2b-224 of the public key at `role/index` under a co-signer's account xpub. */
export const keyHashAt = (accountXpubHex: XpubHex, role: number, index: number): Effect.Effect<KeyHashHex, CoreError> =>
  Keys.derivePublicPath(accountXpubHex, [role, index]).pipe(
    // A derived xpub is pubkey ‖ chain code; the key hash covers the pubkey only.
    Effect.map((childXpub) => childXpub.slice(0, 64)),
    Effect.flatMap(Keys.keyHash),
  )

/** Payment (role 0) key hash at `index`. */
export const paymentKeyHashAt = (accountXpubHex: XpubHex, index: number): Effect.Effect<KeyHashHex, CoreError> =>
  keyHashAt(accountXpubHex, MULTISIG_PAYMENT_ROLE, index)

/** Stake (role 2) key hash — pinned at index 0. */
export const stakeKeyHashOf = (accountXpubHex: XpubHex): Effect.Effect<KeyHashHex, CoreError> =>
  keyHashAt(accountXpubHex, MULTISIG_STAKE_ROLE, STAKE_INDEX)

/**
 * Compile a template to native-script CBOR, resolving each co-signer tag through
 * `keyHashOfTag`.
 *
 * A tag with no entry is a hard failure rather than a skipped leaf: dropping it
 * would silently produce a *weaker* script than the roster describes — a 2-of-3
 * quietly becoming a 2-of-2.
 */
export const compileTemplate = (
  template: ScriptTemplate,
  keyHashOfTag: ReadonlyMap<string, KeyHashHex>,
): Effect.Effect<ScriptHex, CoreError> => {
  const compile = (node: ScriptTemplate): Effect.Effect<ScriptHex, CoreError> => {
    switch (node.kind) {
      case 'cosigner': {
        const keyHash = keyHashOfTag.get(node.tag)
        if (keyHash === undefined) {
          return Effect.die(new Error(`compileTemplate: no key hash for ${node.tag}`))
        }
        return Scripts.pubkey(keyHash)
      }
      case 'all':
        return Effect.forEach(node.scripts, compile).pipe(Effect.flatMap(Scripts.all))
      case 'any':
        return Effect.forEach(node.scripts, compile).pipe(Effect.flatMap(Scripts.any))
      case 'atLeast':
        return Effect.forEach(node.scripts, compile).pipe(
          Effect.flatMap((scripts) => Scripts.nOfK(BigInt(node.n), scripts)),
        )
      case 'invalidBefore':
        return Scripts.invalidBefore(node.slot)
      case 'invalidHereafter':
        return Scripts.invalidHereafter(node.slot)
    }
  }
  return compile(template)
}

/** Tag → payment key hash at `index`, across the whole roster. */
export const paymentKeyHashes = (
  coSigners: readonly CoSignerRef[],
  index: number,
): Effect.Effect<ReadonlyMap<string, KeyHashHex>, CoreError> =>
  Effect.forEach(coSigners, (c) =>
    paymentKeyHashAt(c.accountXpubHex, index).pipe(Effect.map((h) => [c.tag, h] as const)),
  ).pipe(Effect.map((pairs) => new Map(pairs)))

/** Tag → stake key hash (index 0), across the whole roster. */
export const stakeKeyHashes = (
  coSigners: readonly CoSignerRef[],
): Effect.Effect<ReadonlyMap<string, KeyHashHex>, CoreError> =>
  Effect.forEach(coSigners, (c) => stakeKeyHashOf(c.accountXpubHex).pipe(Effect.map((h) => [c.tag, h] as const))).pipe(
    Effect.map((pairs) => new Map(pairs)),
  )

export type SharedScripts = {
  readonly paymentScriptHex: ScriptHex
  readonly stakingScriptHex: ScriptHex
  /** A SCRIPT hash — 28 bytes like a key hash, which is why it is not `KeyHashHex`. */
  readonly paymentScriptHashHex: string
  readonly stakingScriptHashHex: string
  readonly addressBech32: Bech32
  readonly rewardAddressBech32: Bech32
  readonly index: number
}

/**
 * The scripts and addresses for one payment index.
 *
 * The staking script does not vary by index (stake keys are pinned at 0), so
 * every address in a wallet shares one reward address — which is what lets a
 * shared wallet delegate as a single stake credential.
 */
export const scriptsAt = (wallet: SharedWallet, index: number): Effect.Effect<SharedScripts, CoreError> =>
  Effect.gen(function* () {
    const paymentHashes = yield* paymentKeyHashes(wallet.coSigners, index)
    const stakeHashes = yield* stakeKeyHashes(wallet.coSigners)
    const paymentScriptHex = yield* compileTemplate(wallet.paymentTemplate, paymentHashes)
    const stakingScriptHex = yield* compileTemplate(wallet.delegationTemplate, stakeHashes)
    const paymentScriptHashHex = yield* Scripts.scriptHash(paymentScriptHex)
    const stakingScriptHashHex = yield* Scripts.scriptHash(stakingScriptHex)
    const addressBech32 = yield* Address.toBech32(
      Address.baseScriptScriptHex(wallet.network, paymentScriptHashHex, stakingScriptHashHex),
    )
    const rewardAddressBech32 = yield* Address.toBech32(Address.rewardScriptHex(wallet.network, stakingScriptHashHex))
    return {
      paymentScriptHex,
      stakingScriptHex,
      paymentScriptHashHex,
      stakingScriptHashHex,
      addressBech32,
      rewardAddressBech32,
      index,
    }
  })

/** The first `count` payment addresses, in index order. */
export const addressesUpTo = (
  wallet: SharedWallet,
  count: number,
): Effect.Effect<readonly SharedScripts[], CoreError> =>
  Effect.forEach(
    Array.from({length: Math.max(0, count)}, (_, i) => i),
    (i) => scriptsAt(wallet, i),
  )

/**
 * The wallet's single reward address, derived without building a payment script.
 *
 * Separate from {@link scriptsAt} because delegation and reward queries need it
 * on its own, and computing a payment index to get it would be arbitrary.
 */
export const rewardAddressOf = (wallet: SharedWallet): Effect.Effect<Bech32, CoreError> =>
  Effect.gen(function* () {
    const stakeHashes = yield* stakeKeyHashes(wallet.coSigners)
    const stakingScriptHex = yield* compileTemplate(wallet.delegationTemplate, stakeHashes)
    const stakingScriptHashHex = yield* Scripts.scriptHash(stakingScriptHex)
    return yield* Address.toBech32(Address.rewardScriptHex(wallet.network, stakingScriptHashHex))
  })

/**
 * THIS wallet's CIP-1854 payment signing path at `index`, for a partial-sign
 * request. The account index comes from the wallet, since a co-signer may hold
 * its shared keys under a non-zero account.
 */
export const ownPaymentPath = (accountIndex: number, index: number): string =>
  `m/1854'/1815'/${accountIndex}'/${MULTISIG_PAYMENT_ROLE}/${index}`

/** THIS wallet's CIP-1854 stake signing path — role 2, index 0. */
export const ownStakePath = (accountIndex: number): string =>
  `m/1854'/1815'/${accountIndex}'/${MULTISIG_STAKE_ROLE}/${STAKE_INDEX}`
