/**
 * Which of a shared wallet's co-signers this device can actually sign as.
 *
 * A roster names co-signers by their CIP-1854 account xpub, so answering "which
 * one am I?" is an equality check — once that xpub is known for each local
 * wallet. It is cached beside the CIP-1852 gov keys (`sharedAccountXpubHex`),
 * derived in whatever ceremony first needed the seed, so this costs no prompt.
 *
 * **This is what replaces signing as co-signer #0 by default.** The old model
 * had one `isSelf` row and one `selfGroupId`, so a device holding two of a
 * wallet's keys could only ever contribute the first — and which signature you
 * gave depended on which wallet happened to be selected, which nothing on screen
 * said.
 *
 * @module
 */

import type {CardanoGovKeys} from '@pnyx/wallet'
import {scriptIndexOf} from '../cosign/envelope'
import type {EnvelopeSigner} from '../cosign/types'
import type {CoSignerRef, SharedWallet} from './types'

/** A local wallet that can produce one of the roster's signatures. */
export type LocalCoSigner = {
  /** The roster row this wallet backs. */
  readonly tag: string
  /** Roster-facing name — whose signature this is. */
  readonly coSignerName: string
  /** The local wallet group whose seed signs it. */
  readonly groupId: string
  /** The local wallet's own name, which may differ from the roster's. */
  readonly walletName: string
  /** That wallet's `WalletSource` — what actually holds the key that signs. */
  readonly walletSource: string | undefined
  /** Witnesses this co-signer has contributed, over how many the transaction needs from them. */
  readonly signed: number
  readonly required: number
}

/** A local wallet's identity for matching: its group and its CIP-1854 account xpub. */
export type LocalWalletKey = {
  readonly groupId: string
  readonly name: string
  readonly source: string | undefined
  /** `undefined` for a wallet whose gov keys have never been derived, or a
   * hardware/watch-only wallet that has no seed here to derive from. */
  readonly govKeys: CardanoGovKeys | null
}

const sameXpub = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * Match roster rows to local wallets.
 *
 * `wallet.selfGroupId` is honoured as a fallback for the row the roster marks
 * `isSelf`, so a wallet created before the xpub was cached still offers its own
 * signature rather than none. A cached xpub wins where both are present — it is
 * evidence rather than a record of intent, and the two can disagree if a wallet
 * was removed and restored under a new group id.
 *
 * Order follows the roster, so the list reads the same as the quorum panel
 * beside it.
 */
export const localCoSignersOf = (
  wallet: Pick<SharedWallet, 'coSigners' | 'selfGroupId'>,
  locals: readonly LocalWalletKey[],
  signers: readonly EnvelopeSigner[] = [],
): readonly LocalCoSigner[] => {
  const out: LocalCoSigner[] = []
  for (const co of wallet.coSigners) {
    const local = matchLocal(co, wallet.selfGroupId ?? null, locals)
    if (local === null) continue
    const rows = signers.filter((s) => s.id === co.tag)
    out.push({
      tag: co.tag,
      coSignerName: co.name,
      groupId: local.groupId,
      walletName: local.name,
      walletSource: local.source,
      // Counted from the envelope's own rows, which carry one entry per script
      // this co-signer owes a witness at — a payment index, or the delegation
      // script. A tick would read "signed" for someone who signed the spend and
      // not the certificate.
      signed: rows.filter((s) => s.signed).length,
      required: rows.length,
    })
  }
  return out
}

const matchLocal = (
  co: CoSignerRef,
  selfGroupId: string | null,
  locals: readonly LocalWalletKey[],
): LocalWalletKey | null => {
  const byXpub = locals.find(
    (l) => l.govKeys?.sharedAccountXpubHex !== undefined && sameXpub(l.govKeys.sharedAccountXpubHex, co.accountXpubHex),
  )
  if (byXpub !== undefined) return byXpub
  if (co.isSelf !== true || selfGroupId === null) return null
  return locals.find((l) => l.groupId === selfGroupId) ?? null
}

/** Whether this co-signer still owes the transaction a witness. */
/**
 * The wallet on this device whose key this is, if any.
 *
 * What makes a roster row *ours* is that its xpub matches one of our wallets —
 * not how the row came to be filled. The create screen used to mark a row from
 * the own-wallet picker and nothing else, so a key you pasted, scanned, or were
 * sent by yourself was labelled as someone else's and contributed no
 * `selfGroupId`. Compared case-insensitively on the hex, like every other
 * co-signer match in this module.
 */
export const localWalletForKey = (accountXpubHex: string, locals: readonly LocalWalletKey[]): LocalWalletKey | null =>
  locals.find(
    (l) => l.govKeys?.sharedAccountXpubHex !== undefined && sameXpub(l.govKeys.sharedAccountXpubHex, accountXpubHex),
  ) ?? null

export const owesSignature = (c: LocalCoSigner): boolean => c.signed < c.required

/**
 * The co-signers this device can still usefully sign as.
 *
 * Empty means no further signature is useful — either every signature we can
 * give has been given, or the transaction already meets its quorum.
 *
 * **Quorum, not roster debt.** `owesSignature` answers "does this row still owe
 * a witness?", which is the same question only for an `all [...]` wallet. Under
 * `at_least n of k` the two diverge the moment quorum is met: a 1-of-2 signed by
 * one local wallet leaves the other still owing its row, so the screen auto-opened
 * a review to sign as it — for a transaction that was already submittable. Worse
 * than theatre, because the fee is budgeted for a quorum's worth of witnesses
 * (`extraSigners` in `send-flow.ts`) and a witness beyond that is unpaid-for bytes.
 */
export const outstandingLocalCoSigners = (
  all: readonly LocalCoSigner[],
  meetsQuorum: boolean,
): readonly LocalCoSigner[] => (meetsQuorum ? [] : all.filter(owesSignature))

/** Roster rows nobody here can sign for, by name — who the transaction is waiting on. */
export const awaitingCoSigners = (
  wallet: Pick<SharedWallet, 'coSigners'>,
  local: readonly LocalCoSigner[],
  signers: readonly EnvelopeSigner[],
): readonly string[] => {
  const mine = new Set(local.map((c) => c.tag))
  return wallet.coSigners
    .filter((co) => {
      if (mine.has(co.tag)) return false
      const rows = signers.filter((s) => s.id === co.tag)
      return rows.length > 0 && rows.some((s) => !s.signed)
    })
    .map((co) => co.name)
}

/**
 * Shared wallets that would be left with no local key if `groupId` were removed.
 *
 * A shared wallet holds no key of its own, so its only signing capability is the
 * co-signer wallets sitting beside it on this device. Remove the last of those
 * and the wallet is still listed, still holds whatever is at its address, and can
 * never spend again — an outcome nothing on the delete screen hinted at.
 *
 * Only wallets that can sign *now* are returned: one already down to other
 * people's keys is not being stranded by this removal, it was imported that way,
 * and that is a legitimate state (watch it, co-sign from an envelope). The guard
 * is against the accident, not the state.
 */
export const strandedByRemoving = (
  groupId: string,
  wallets: readonly Pick<SharedWallet, 'id' | 'name' | 'coSigners' | 'selfGroupId'>[],
  locals: readonly LocalWalletKey[],
): readonly Pick<SharedWallet, 'id' | 'name'>[] => {
  const remaining = locals.filter((l) => l.groupId !== groupId)
  return wallets
    .filter((w) => localCoSignersOf(w, locals).length > 0 && localCoSignersOf(w, remaining).length === 0)
    .map((w) => ({id: w.id, name: w.name}))
}

/** Signature rows for one co-signer, for a per-script breakdown. */
export const rowsFor = (signers: readonly EnvelopeSigner[], tag: string): readonly EnvelopeSigner[] =>
  [...signers.filter((s) => s.id === tag)].sort((a, b) => scriptIndexOf(a) - scriptIndexOf(b))
