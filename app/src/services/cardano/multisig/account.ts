/**
 * A `CardanoAccountContext` for a CIP-1854 shared wallet.
 *
 * This is what lets the ordinary rail serve a shared wallet: once the account
 * exists, send, staking, consolidation and the signing adapter all work against
 * it without knowing it is one, because everything that differs is carried by
 * the account's {@link SpendAuthority}.
 *
 * @module
 */

import {Address as EvolutionAddress} from '@evolution-sdk/evolution'
import {Address} from '@pnyx/cardano-core'
import type {CoreError} from '@pnyx/cardano-core/Op'
import type {OwnedSigningKey} from '@pnyx/tx-review'
import {Effect} from 'effect'
import type {CardanoAccountContext, ScriptIndexAuthority, SpendAuthority} from '../account'
import {ownPaymentPath, ownStakePath, paymentKeyHashes, scriptsAt, stakeKeyHashes, stakeKeyHashOf} from './derive'
import {validityFor} from './spend'
import {signPolicy} from './template'
import type {SharedWallet} from './types'

/**
 * Build the account context for spending a shared wallet.
 *
 * `spendIndex` is where change and receives land, and it is a parameter rather
 * than derived here because it is a property of the spend: a shared wallet has an
 * address per index and its funds decide which one leads.
 *
 * `otherIndexes` are the wallet's *other* funded indexes. They join the authority
 * so one transaction can spend them all — which is what an ordinary key wallet
 * already does across its own addresses, and what the ledger has always allowed.
 * Each contributes its own compiled script, its own leaves and its own signing
 * path, because a co-signer's key differs at every index.
 */
export const cardanoAccountFromSharedWallet = (
  wallet: SharedWallet,
  spendIndex: number,
  otherIndexes: readonly number[] = [],
): Effect.Effect<CardanoAccountContext, CoreError> =>
  Effect.gen(function* () {
    const scripts = yield* scriptsAt(wallet, spendIndex)
    const policy = signPolicy(wallet.paymentTemplate)
    const self = wallet.coSigners.find((c) => c.isSelf === true)

    // The spending index first, then the rest ascending and deduped — the order
    // `nativeScriptHexes` and the envelope's `keyIndexes` are both written in.
    const indexes = [spendIndex, ...[...new Set(otherIndexes)].filter((i) => i !== spendIndex).sort((a, b) => a - b)]

    const perIndex = yield* Effect.forEach(indexes, (keyIndex) =>
      Effect.gen(function* () {
        const at = keyIndex === spendIndex ? scripts : yield* scriptsAt(wallet, keyIndex)
        const byTag = yield* paymentKeyHashes(wallet.coSigners, keyIndex)
        return {
          authority: {
            keyIndex,
            scriptHashHex: at.paymentScriptHashHex,
            nativeScriptHex: at.paymentScriptHex,
            signerKeyHashes: [...byTag.values()],
            requiredSigners: policy.required,
          } satisfies ScriptIndexAuthority,
          /**
           * Our own key at this index, when the roster says one of the co-signers
           * is us. A roster of other people's xpubs is a wallet we can watch but
           * never witness for, and an empty registry says exactly that rather than
           * pretending otherwise.
           */
          own:
            self === undefined
              ? null
              : ({
                  keyHashHex:
                    byTag.get(self.tag) ?? (yield* Effect.die(new Error('self co-signer missing a key hash'))),
                  path: ownPaymentPath(wallet.accountIndex, keyIndex),
                } satisfies OwnedSigningKey),
          scriptHashHex: at.paymentScriptHashHex,
        }
      }),
    )

    // Index-free, because CIP-1854 pins stake keys at role 2 index 0 — so the
    // delegation script taken at the spending index is the account's only one.
    const stakeByTag = yield* stakeKeyHashes(wallet.coSigners)
    const stakePolicy = signPolicy(wallet.delegationTemplate)

    const authority: SpendAuthority = {
      kind: 'script',
      indexes: perIndex.map((p) => p.authority),
      stake: {
        scriptHashHex: scripts.stakingScriptHashHex,
        nativeScriptHex: scripts.stakingScriptHex,
        signerKeyHashes: [...stakeByTag.values()],
        requiredSigners: stakePolicy.required,
      },
      validity: validityFor(wallet),
      signingGroupId: wallet.selfGroupId ?? null,
    }

    // One entry per index, so a transaction spending two of them resolves two
    // signing paths and the signer produces a witness for each. A registry holding
    // only the spending index's key is why a multi-index spend used to go out a
    // signature short.
    //
    // Plus our stake key, which authorises nothing a spend needs and everything a
    // delegation does. A key wallet's registry has always carried both; this one
    // carried payment keys alone, so a delegation would have resolved no path at
    // all and produced a transaction missing the one witness that makes it a
    // delegation.
    const ownStake =
      self === undefined
        ? null
        : ({
            keyHashHex:
              stakeByTag.get(self.tag) ?? (yield* Effect.die(new Error('self co-signer missing a stake hash'))),
            path: ownStakePath(wallet.accountIndex),
          } satisfies OwnedSigningKey)
    const keyRegistry: readonly OwnedSigningKey[] = [
      ...perIndex.flatMap((p) => (p.own === null ? [] : [p.own])),
      ...(ownStake === null ? [] : [ownStake]),
    ]

    // The stake credential is a script hash, so the reward address needs the
    // script encoding — `Address.rewardHex` would build a key-credential
    // account and quietly point at nothing.
    const rewardAddressHex = Address.rewardScriptHex(wallet.network, scripts.stakingScriptHashHex)

    return {
      // ⚠️ A shared wallet's address is a SCRIPT-credential base address. It is typed here for
      // the same reason the key path types it — so the compute path stops re-decoding a string
      // this function already produced — and `fromBech32` accepts it exactly as it does a key one.
      address: EvolutionAddress.fromBech32(scripts.addressBech32),
      addressBech32: scripts.addressBech32,
      addressHex: yield* Effect.succeed(
        // The change address: funds return to the same script, so they stay
        // under the same policy.
        Address.baseScriptScriptHex(wallet.network, scripts.paymentScriptHashHex, scripts.stakingScriptHashHex),
      ),
      // These are script hashes, not key hashes. The field names are the
      // account's existing vocabulary for "the credential"; `authority` is what
      // says which kind it is.
      paymentKeyHashHex: scripts.paymentScriptHashHex,
      stakeKeyHashHex: scripts.stakingScriptHashHex,
      authority,
      rewardAddressBech32: scripts.rewardAddressBech32,
      rewardAddressHex,
      keyRegistry,
      walletContext: {
        // Empty, and that is the honest answer: a shared wallet holds no payment
        // key of its own. Its credentials are script hashes, which review reads
        // from `paymentScriptHashes` — the set that actually classifies them.
        paymentKeyHashes: new Set<string>(),
        // Every index, so a transaction paying another of this wallet's own
        // addresses reads as staying inside the wallet.
        paymentScriptHashes: new Set(perIndex.map((p) => p.scriptHashHex)),
        stakeKeyHashHex: scripts.stakingScriptHashHex,
        // So review can tell this wallet delegating itself — routine, and the only
        // way a shared wallet stakes — from a stranger's script acting on it.
        stakeIsScript: true,
      },
    }
  })

/** The stake key hash this wallet contributes to the delegation script, if it is a participant. */
export const ownStakeKeyHash = (wallet: SharedWallet): Effect.Effect<string | null, CoreError> => {
  const self = wallet.coSigners.find((c) => c.isSelf === true)
  return self === undefined ? Effect.succeed(null) : stakeKeyHashOf(self.accountXpubHex)
}
