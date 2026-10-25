/**
 * What a UTxO **is** to this account: ours or not, movable or not, and by what means.
 *
 * One boolean used to answer all of that — `isKeyCredentialBase`, introduced to skip escrows like a
 * DEX open order or a NIGHT redeem still thawing. That distinction is real, but "not a key
 * credential" is only a proxy for it, and the proxy now fails in both directions: a CIP-1854 shared
 * wallet is script-payment and *is* ours, and a CIP-113 smart wallet is script-payment over our own
 * stake credential and is ours too, spendable through a known contract.
 *
 * The discriminator is not "script or not". It is **do we know how to spend this** — a lookup
 * against what we know, not a property of the address. Full reasoning, the cases, and the
 * sequencing: `docs/CARDANO_CUSTODY_MODEL.md`.
 *
 * Pure. Knowledge enters as {@link CustodyProviders}, so this module never reaches for a registry,
 * a deployment record or the network, and can be tested by stating what is known.
 *
 * @module
 */

import {Bech32} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {logger} from '../../logger'

/** Why a UTxO is associated with the account but not movable by it. */
export type AssociationReason =
  /**
   * A script we recognise as an earlier generation of a protocol we support. Nameable, so the UI
   * can say which — but only where a source establishes it.
   */
  | {readonly kind: 'prior-generation'; readonly protocol: string; readonly generationId: string}
  /**
   * A script nothing claims. Deliberately *not* labelled: an unattributed script sharing our stake
   * credential is as likely a DEX or a multisig as anything else, and naming it would invent
   * history. See the rendering rules in the model doc.
   */
  | {readonly kind: 'unrecognised-script'}

export type Custody =
  /** Our own key witnesses it. The only bucket coin selection may use today. */
  | {readonly kind: 'key'}
  /** A shared wallet we hold a roster for: spendable, but not unilaterally. */
  | {readonly kind: 'script-quorum'; readonly walletId: string}
  /** Spendable only through its protocol's contract. */
  | {readonly kind: 'script-protocol'; readonly protocol: 'cip113'}
  /** Ours economically; not movable by us. An honest state, not a failure. */
  | {readonly kind: 'associated'; readonly reason: AssociationReason}
  /** Nothing to do with this account. */
  | {readonly kind: 'foreign'}

/**
 * What this wallet knows, as claims over payment credentials.
 *
 * A provider answers "is this credential mine, and on what terms?" and nothing else. Adding a
 * standard means adding a claim here; no existing branch has to learn about it.
 */
export type CustodyProviders = {
  /** Payment credentials we hold a signing key for, lowercase hex. */
  readonly ownKeyCredentials: ReadonlySet<string>
  /** Script hash → shared-wallet id, for rosters we hold. */
  readonly sharedWalletScripts: ReadonlyMap<string, string>
  /**
   * Script hash → the protocol that claims it. A protocol's *current* credential resolves to
   * `script-protocol`; a superseded one it can still name resolves to `associated`.
   */
  readonly protocolScripts: ReadonlyMap<string, {readonly protocol: 'cip113'; readonly generationId?: string}>
}

/**
 * How this wallet defines "ours" for a *key* credential.
 *
 * Not a nuance — the two wallet kinds genuinely disagree, and the disagreement is load-bearing.
 *
 * `own-keys` is a signing wallet: ours means a credential we hold a key for, and a stranger's key
 * sharing our stake credential (which is what multi-delegation produces) is theirs.
 *
 * `stake-account` is watch-only, which impersonates a whole stake account and holds no keys at all.
 * There ownership *is* the stake credential, so any key-credential address under it counts. ⚠️ That
 * admits a foreign key paired with our stake credential, which is a known limit of watch-only
 * rather than of this module — narrowing it is a separate decision. Recorded in
 * `docs/CARDANO_CUSTODY_MODEL.md` §7.
 *
 * Scripts are unaffected: those are resolved by claim in both modes, never by this.
 */
export type KeyOwnership = 'own-keys' | 'stake-account'

export const noCustodyKnowledge: CustodyProviders = {
  ownKeyCredentials: new Set(),
  sharedWalletScripts: new Map(),
  protocolScripts: new Map(),
}

/**
 * Classify one address against what we know.
 *
 * `sharesOurStake` is the association test and is supplied rather than derived: the account-level
 * query is already keyed on our stake credential, so every row it returns shares it by
 * construction, while a per-address fetch has no such guarantee. Making the caller state it keeps
 * this module from re-deriving a fact its caller already knows — and from getting it wrong.
 *
 * An address that will not decode is `foreign`. There is nothing to be said about bytes we cannot
 * read, and guessing is how a wrong balance gets rendered confidently.
 */
export const custodyOfAddress = (
  addressBech32: string,
  providers: CustodyProviders,
  context: {readonly sharesOurStake: boolean; readonly keyOwnership: KeyOwnership},
): Custody => {
  const payment = paymentCredentialOf(addressBech32)
  if (payment === null) return {kind: 'foreign'}
  const paymentCred = payment.hashHex

  if (!payment.isScript) {
    if (providers.ownKeyCredentials.has(paymentCred)) return {kind: 'key'}
    // Watch-only holds no keys, so "a credential we hold" would classify everything as foreign and
    // report an empty wallet. There, the stake credential is the definition of ownership.
    if (context.keyOwnership === 'stake-account' && context.sharesOurStake) return {kind: 'key'}
  }

  const sharedWalletId = providers.sharedWalletScripts.get(paymentCred)
  if (sharedWalletId !== undefined) return {kind: 'script-quorum', walletId: sharedWalletId}

  const protocol = providers.protocolScripts.get(paymentCred)
  if (protocol !== undefined) {
    return protocol.generationId === undefined
      ? {kind: 'script-protocol', protocol: protocol.protocol}
      : {
          kind: 'associated',
          reason: {kind: 'prior-generation', protocol: protocol.protocol, generationId: protocol.generationId},
        }
  }

  // Past every claim, and the key/script split matters here rather than at the top.
  //
  // An unclaimed **script** over our stake credential is an escrow: value that came from this
  // account and is held under rules we do not know. Worth showing, and worth showing as unexplained.
  //
  // An unclaimed **key** is somebody else's ordinary address that happens to share our stake
  // credential — which is what multi-delegation produces. Nothing is escrowed and nothing is ours,
  // so calling it an unrecognised script would be wrong twice: it is not a script, and there is no
  // mystery about it.
  if (!payment.isScript) return {kind: 'foreign'}
  return context.sharesOurStake ? {kind: 'associated', reason: {kind: 'unrecognised-script'}} : {kind: 'foreign'}
}

const paymentCredentialOf = (addressBech32: string): {readonly hashHex: string; readonly isScript: boolean} | null => {
  try {
    const info = Address.inspect(Address.fromBech32Sync(Bech32(addressBech32)))
    return info.paymentCredHex === undefined
      ? null
      : {hashHex: info.paymentCredHex.toLowerCase(), isScript: info.paymentIsScript === true}
  } catch (e: unknown) {
    // ⚠️ This answers "whose key spends this address?". `null` is also the no-payment-credential
    // branch above, so a custody question we failed to evaluate and one with no answer are the
    // same result on a path that decides what we can sign.
    logger.warn('Address could not be inspected for custody', {origin: 'cardano/custody', error: String(e)})
    return null
  }
}

/**
 * Whether coin selection may use a UTxO under this custody.
 *
 * ⚠️ Only `key` today, and widening this is not a one-line change. `projectSpendable` returns a
 * flat list with no custody notion, so the first non-`key` bucket admitted here can be picked to
 * pay a fee on an ordinary send — and that transaction cannot be witnessed. Coin selection has to
 * become custody-aware in the *same* change that widens this, never after.
 */
export const isFreelySpendable = (custody: Custody): boolean => custody.kind === 'key'

export type CustodyPartition<T> = {
  /** Coin selection's set. Everything {@link isFreelySpendable} admits. */
  readonly spendable: readonly T[]
  /** Held under a custody we understand but cannot spend from freely. */
  readonly restricted: readonly {readonly utxo: T; readonly custody: Custody}[]
  /** Not this account's. Dropped from every total. */
  readonly foreign: readonly T[]
}

/**
 * Split a set of rows by custody.
 *
 * The point of a partition rather than a filter: the restricted rows are *kept*, so a balance can
 * report them under their own heading instead of a user's DEX position silently vanishing from a
 * total. Filtering was the stopgap; this is what replaces it.
 */
/**
 * ⚠️ `addressOf` rather than a `{address?: string}` constraint: the rows are Evolution `UTxO`s,
 * whose `address` is an `Address` rather than bech32. The extractor also **removed a branch** — the
 * old shape made the address OPTIONAL, and a row without one was classed `foreign` because
 * attributing it to the account's primary address is how a foreign coin becomes a spendable one.
 * An address is required on Evolution's `UTxO`, so that case cannot arise.
 */
export const partitionByCustody = <T>(
  rows: readonly T[],
  providers: CustodyProviders,
  context: {readonly sharesOurStake: boolean; readonly keyOwnership: KeyOwnership},
  addressOf: (row: T) => string,
): CustodyPartition<T> => {
  const spendable: T[] = []
  const restricted: {utxo: T; custody: Custody}[] = []
  const foreign: T[] = []
  for (const row of rows) {
    const custody = custodyOfAddress(addressOf(row), providers, context)
    if (isFreelySpendable(custody)) spendable.push(row)
    else if (custody.kind === 'foreign') foreign.push(row)
    else restricted.push({utxo: row, custody})
  }
  return {spendable, restricted, foreign}
}
