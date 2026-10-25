/**
 * Whether a wallet can act as a co-signer, and where its CIP-1854 account xpub
 * comes from.
 *
 * This exists because the first version assumed every wallet has a mnemonic in
 * the enclave. Only `'mnemonic'` wallets do, so "Add yourself" on any other
 * source failed with `VaultError{not-found}` — surfaced, through a blanket
 * catch, as "Enter a valid co-signer key". A message about the text field, for a
 * failure in the keychain.
 *
 * The rule is a property of the source, so it is decided *before* the affordance
 * is offered rather than by attempting and catching.
 *
 * @module
 */

import type {WalletSource} from '@pnyx/wallet'
// Type-only, so this stays a pure module with no i18n runtime dependency. It buys
// the compiler checking that every reason below names a string that exists.
import type {TranslationKey} from '../../../i18n/types'

/** What spends from a wallet: its own key, a script, or nothing. */
export type SpendingAuthority = 'key' | 'script' | 'none'

/**
 * `read-only` holds a watch-only xpub and can never produce a witness, so it has
 * no spending authority at all. Everything else signs with a key it holds; a
 * shared wallet is spent by its script.
 */
export const spendingAuthorityOf = (source: WalletSource): SpendingAuthority =>
  source === 'multisig' ? 'script' : source === 'read-only' ? 'none' : 'key'

/**
 * Why a wallet cannot contribute a co-signer key.
 *
 * Three different facts, not one: a watch-only wallet holds no key at all, a
 * shared wallet is spent by a policy rather than a key, and an xpriv import holds
 * seed-equivalent material with nowhere to read it from. They were one value
 * (`'no-signing-key'`) and the picker told a shared wallet it was watch-only.
 */
export type IneligibleReason =
  /** Holds a watch-only xpub; there is no key here, ever. */
  | 'watch-only'
  /** Spent by its script over other people's keys, so it has no key of its own. */
  | 'is-script'
  /** Has seed-equivalent material, but no vault slot to read it from — see below. */
  | 'no-xpriv-slot'

/** How this wallet's shared account xpub can be obtained. */
export type CoSignerKeySource =
  /** Available here and now: the cached xpub, or the enclave seed behind a ceremony. */
  | {readonly kind: 'seed'}
  /** Already read from the device and cached — costs nothing, needs nothing connected. */
  | {readonly kind: 'cached'}
  /** Derivable, but the device has to be connected and asked for it. */
  | {readonly kind: 'device'}
  /** Cannot participate — a wallet that cannot sign cannot satisfy a quorum. */
  | {readonly kind: 'unavailable'; readonly reason: IneligibleReason}

/**
 * Where a wallet's co-signer key comes from, by source.
 *
 * `imported-xpriv` is **not** listed as seed-derivable, despite holding
 * seed-equivalent material. `deriveGroupCoSignerXpub` reads the *mnemonic* vault
 * slot, and there is no xpriv store behind it — `ceremony-cache.ts` reserves an
 * `'xpriv'` material kind but nothing writes one. Claiming `'seed'` here would
 * offer a button that fails at the vault, which is the exact shape of the bug
 * this module exists to prevent. It rejoins once that slot is real, and
 * `signerKindOf` agrees today: it answers `null` for this source too.
 */
export const coSignerKeySourceOf = (source: WalletSource): CoSignerKeySource => {
  switch (source) {
    case 'mnemonic':
      return {kind: 'seed'}
    case 'imported-xpriv':
      return {kind: 'unavailable', reason: 'no-xpriv-slot'}
    case 'hardware':
      return {kind: 'device'}
    case 'read-only':
      return {kind: 'unavailable', reason: 'watch-only'}
    // A shared wallet is spent by a script over other people's keys, so it holds
    // no key of its own to contribute to a second roster. Nesting a shared wallet
    // inside another is a template question, not an xpub the picker can hand over.
    case 'multisig':
      return {kind: 'unavailable', reason: 'is-script'}
  }
}

/** True when this wallet can be a co-signer at all, whatever the ceremony costs. */
export const canCoSign = (source: WalletSource): boolean => coSignerKeySourceOf(source).kind !== 'unavailable'

/**
 * The same answer for a caller that also knows whether the key is already
 * cached — which is the difference between an affordance that works right now
 * and one that has to ask for a device first.
 *
 * Only `'hardware'` splits on the cache, because only a hardware wallet can be
 * *unable* to produce its key — its device may not be connected. A `'mnemonic'`
 * wallet reports `'seed'` either way: it can always produce one, and whether that
 * costs a derivation is `resolveGroupCoSignerXpub`'s business, not an affordance
 * decision.
 *
 * ⚠️ This used to say a mnemonic wallet stays `'seed'` *so that* the biometric
 * ceremony is never skipped. That reasoning is gone: the xpub is public and
 * already persisted beside the gov keys, so the ceremony guarded bytes anything
 * on the device could read — see `resolveGroupCoSignerXpub`.
 */
export const coSignerKeyAccessOf = (source: WalletSource, sharedXpubCached: boolean): CoSignerKeySource => {
  const base = coSignerKeySourceOf(source)
  return base.kind === 'device' && sharedXpubCached ? {kind: 'cached'} : base
}

/** True when the key can be produced without connecting anything. */
export const coSignerKeyIsReady = (access: CoSignerKeySource): boolean =>
  access.kind === 'seed' || access.kind === 'cached'

const REASON_KEY: Readonly<Record<IneligibleReason, TranslationKey>> = {
  'watch-only': 'multisig.create.ineligibleReadOnly',
  'is-script': 'multisig.create.ineligibleShared',
  'no-xpriv-slot': 'multisig.create.ineligibleImportedXpriv',
}

/**
 * The i18n key for one reason.
 *
 * A `Record` rather than a chain of conditionals, so a new reason is a type error
 * here instead of silently reusing whichever message came first — which is how a
 * shared wallet came to be told it was watch-only. Total, so a caller holding a
 * reason needs no fallback.
 */
export const reasonKeyOf = (reason: IneligibleReason): TranslationKey => REASON_KEY[reason]

/** The same, for a caller holding only the source. `null` when the wallet can co-sign. */
export const ineligibleReasonKey = (source: WalletSource): TranslationKey | null => {
  const keySource = coSignerKeySourceOf(source)
  return keySource.kind === 'unavailable' ? reasonKeyOf(keySource.reason) : null
}
