/**
 * Which local wallet, if any, can give a signature a multiparty transaction is waiting for.
 *
 * The multisig answer to this question is `localCoSignersOf`, and it cannot be reused: it
 * matches a shared wallet's roster against cached **CIP-1854 account xpubs**, and opens
 * with `if (wallet === null) return []`. A multiparty transaction has no shared wallet and
 * no CIP-1854 anything — its signers are ordinary wallets identified by the **payment key
 * hash** that funds their inputs. So the lookup is a different lookup.
 *
 * Everything downstream already exists. Once this says "you are Bob and Bob still owes a
 * signature", the paths come from `resolveCardanoSigningPaths` against Bob's own resolved
 * inputs — the same call the review makes — because signing your own inputs in a
 * multiparty body is exactly signing your own inputs in any body.
 *
 * **`canSign` is not optional and not inferable from the match.** Alice watches Bob
 * read-only, so *her* device holds Bob's payment key hashes and matches his roster row
 * perfectly. Offering her the signature would be offering something no key on that device
 * can produce. The caller decides which wallets hold keys; this only decides which of them
 * the transaction is waiting on.
 *
 * Pure, so both of those rules are testable without a wallet.
 *
 * @module
 */

import type {EnvelopeSigner} from '../cosign/types'

/** A wallet on this device, and the payment key hashes it controls. */
export type LocalWallet = {
  readonly groupId: string
  readonly name: string
  /** blake2b-224 payment key hashes across the wallet's known addresses. */
  readonly paymentKeyHashes: readonly string[]
  /** False for read-only: it can recognise the row and never satisfy it. */
  readonly canSign: boolean
  /** Drives `resolveSigningLayer` — hardware and software sign by different routes. */
  readonly source?: string | undefined
}

/** A roster row this device can answer. */
export type LocalMultipartySigner = {
  readonly groupId: string
  readonly walletName: string
  /** `EnvelopeSigner.id` — what the roster calls this party. */
  readonly signerId: string
  /** The name the roster carries, which may differ from what this device calls the wallet. */
  readonly signerName: string
  readonly keyHashHex: string
  readonly signed: boolean
  readonly source?: string | undefined
}

const normalise = (hex: string): string => hex.toLowerCase()

/**
 * Every roster row this device holds a signing key for, in roster order.
 *
 * A wallet matching several rows yields several entries — one signature is owed per row,
 * and collapsing them would under-count what this device still has to give.
 */
export const localMultipartySignersOf = (
  signers: readonly EnvelopeSigner[],
  wallets: readonly LocalWallet[],
): readonly LocalMultipartySigner[] => {
  const owners = new Map<string, LocalWallet>()
  for (const wallet of wallets) {
    if (!wallet.canSign) continue
    for (const hash of wallet.paymentKeyHashes) {
      // First wallet wins: the same key hash under two groups is one key imported twice,
      // and either group produces the same witness.
      if (!owners.has(normalise(hash))) owners.set(normalise(hash), wallet)
    }
  }

  const found: LocalMultipartySigner[] = []
  for (const signer of signers) {
    const owner = owners.get(normalise(signer.keyHashHex))
    if (owner === undefined) continue
    found.push({
      groupId: owner.groupId,
      walletName: owner.name,
      signerId: signer.id,
      signerName: signer.name,
      keyHashHex: signer.keyHashHex,
      signed: signer.signed,
      ...(owner.source === undefined ? {} : {source: owner.source}),
    })
  }
  return found
}

/** The rows still owed — what "sign as" offers, and empty when this device is done. */
export const outstandingMultipartySigners = (
  local: readonly LocalMultipartySigner[],
): readonly LocalMultipartySigner[] => local.filter((signer) => !signer.signed)
