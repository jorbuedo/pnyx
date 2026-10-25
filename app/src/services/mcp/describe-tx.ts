/**
 * A transaction as an agent that has never seen Cardano can act on it.
 *
 * ⚠️ **Not the review IR verbatim.** `ReviewedTransaction` is the app's own shape, and handing it over
 * would repeat the mistake that made a model report 2 ADA as 200: it speaks in `ownership.level`,
 * `stake-hijack`, asset ids and bigints, and a caller that has to interpret all of that will interpret
 * some of it wrongly and say so confidently. What an agent needs is the *conclusions* — what this
 * wallet gains or loses, who is paid, what else the transaction does, and what is alarming about it.
 *
 * ⚠️ **The same analysis the person approves against.** This projects the IR the review screen renders,
 * so an agent's description and the screen cannot disagree. It is the *description* that is shared, not
 * the decision: the person still approves on the screen, and an agent must never present its own
 * paraphrase as the thing being consented to.
 *
 * Pure, so every warning's wording and every sign convention is a unit test rather than a device
 * session.
 *
 * @module
 */

import type {ReviewedAmount, ReviewedIO, ReviewedTransaction, TransactionWarning} from '@pnyx/tx-review'

/** Lovelace as ADA, exactly — string arithmetic, because six decimal places do not survive a float. */
export const adaOf = (lovelace: bigint): string => {
  const negative = lovelace < 0n
  const digits = (negative ? -lovelace : lovelace).toString().padStart(7, '0')
  const whole = digits.slice(0, -6)
  const fraction = digits.slice(-6).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`
}

/** The asset name as text, or `null` when its bytes are not text — never mojibake. */
export const readableAssetName = (hex: string): string | null => {
  if (hex === '') return null
  const bytes = Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16))
  // CIP-68 prefixes a four-byte label, so a well-formed name still starts with unprintable bytes.
  const printable = [...bytes].filter((b) => b >= 0x20 && b <= 0x7e)
  const text = String.fromCharCode(...printable)
  return text === '' ? null : text
}

const splitAsset = (assetId: string) => {
  const [policyId = '', assetNameHex = ''] = assetId.split('.')
  return {policyId, assetNameHex, name: readableAssetName(assetNameHex)}
}

/** Amounts split into the coin and the rest, both in the shapes an agent can use directly. */
const amountsOf = (amounts: readonly ReviewedAmount[]) => {
  const lovelace = amounts.find((a) => a.assetId === undefined)?.quantity ?? 0n
  return {
    lovelace: lovelace.toString(),
    ada: adaOf(lovelace),
    assets: amounts
      .filter((a) => a.assetId !== undefined)
      .map((a) => ({...splitAsset(a.assetId as string), quantity: a.quantity.toString()})),
  }
}

/**
 * ⚠️ **Every warning in words, because the tag alone is unreadable.** `stake-credential-reuse` names a
 * real attack and tells an agent nothing; a sentence tells it what to say to a person. A tag with no
 * sentence would reach the agent as a bare string, so the fallback names it as unrecognised rather
 * than dropping it — a warning that disappears is worse than one nobody can read.
 */
const WARNING_TEXT: Readonly<Record<TransactionWarning, string>> = {
  'large-fee': 'the fee is unusually large for what this transaction does',
  'change-folded-into-fee': 'leftover change was too small to return and was added to the fee instead',
  'no-ttl': 'this transaction has no expiry, so it could be submitted at any time in the future',
  minting: 'it creates new tokens',
  burning: 'it destroys tokens permanently',
  'plutus-contract': 'it runs a smart contract, which can move funds in ways the outputs alone do not show',
  'governance-action': 'it takes a governance action',
  'unknown-certificate': 'it carries a certificate this wallet does not recognise',
  'script-certificate': 'a certificate here is authorised by a script rather than a key',
  'unresolved-inputs': 'some inputs could not be read, so what is being spent is not fully known',
  'unknown-body-fields': 'it contains transaction fields this wallet does not recognise',
  'treasury-donation': 'it donates to the treasury',
  'multi-sig': 'it needs signatures from more than one key',
  'stake-credential-reuse':
    'an output puts this wallet’s stake credential under someone else’s payment key — coins sent there earn rewards for this wallet but cannot be spent by it',
  'ends-external-delegation':
    'it spends coins that were parked under a different stake key, which ends that delegation',
  'spends-unconfirmed-input': 'it spends an output from a transaction that has not confirmed yet',
  'leaked-signing-key':
    'a signature here was made with a nonce derived from public data — the signing key may be recoverable from it',
}

/** What a recipient of this transaction is told about. */
const recipientOf = (io: ReviewedIO) => ({
  address: io.address.bech32 ?? io.address.hex,
  // ⚠️ Named when it is not bech32, rather than passed off as an address: the builders take bech32, so
  // a hex string handed back into one would be refused and the reason would be a mystery.
  ...(io.address.bech32 === undefined ? {addressIsHexOnly: true} : {}),
  ...amountsOf(io.amounts),
})

/** One line per thing the transaction does beyond moving coins. */
const operationText = (operation: ReviewedTransaction['operations'][number]): string => {
  switch (operation.kind) {
    case 'minting':
      return operation.burns ? 'destroys tokens' : 'creates tokens'
    case 'stake-registration':
      return 'registers a stake key (a deposit is paid, and refunded if it is ever deregistered)'
    case 'stake-deregistration':
      return 'deregisters a stake key (the deposit is refunded)'
    case 'stake-delegation':
      return `delegates staking to pool ${operation.poolKeyHashHex.slice(0, 12)}…`
    case 'vote-delegation':
      return 'delegates governance voting to a DRep'
    default:
      // Not a fallback that hides anything: the kind is the app's own tag, and naming it is more use
      // than silence when a new certificate type appears before this list learns about it.
      return `performs a ${operation.kind.replace(/-/g, ' ')}`
  }
}

/**
 * The transaction, described.
 *
 * ⚠️ **`understood` is the field to read first.** When inputs could not be resolved, the effect on this
 * wallet is computed from a partial view and is *wrong* — not merely imprecise. An agent that reports a
 * confident figure from that is the same failure as reading CBOR by eye, so the numbers are still given
 * (they are what is known) and are flatly labelled untrustworthy.
 */
export const describeTransaction = (reviewed: ReviewedTransaction) => {
  const understood = reviewed.unresolvedInputs.length === 0
  const theirs = reviewed.outputs.filter((io) => io.ownership.level !== 'own')
  return {
    understood,
    ...(understood
      ? {}
      : {
          warningAboutThisAnswer:
            `${reviewed.unresolvedInputs.length} of this transaction's inputs could not be read, so ` +
            'everything below about what this wallet gains or loses is computed from a partial view and ' +
            'may be wrong. Do not report these figures as the effect of signing — say they cannot be ' +
            'determined.',
        }),
    thisWalletChangesBy: {
      // Negative means leaving this wallet. The fee is already inside it.
      ...amountsOf(reviewed.ownDelta),
      note: 'negative means leaving this wallet. The fee is already included.',
    },
    fee: {lovelace: reviewed.fee.toString(), ada: adaOf(reviewed.fee)},
    paysOut: theirs.map(recipientOf),
    /** Outputs that come back to this wallet — change, and anything sent to itself. */
    returnsToThisWallet: reviewed.outputs.filter((io) => io.ownership.level === 'own').map(recipientOf),
    alsoDoes: reviewed.operations.map(operationText),
    warnings: reviewed.warnings.map((w) => WARNING_TEXT[w] ?? `an unrecognised warning: ${w}`),
    ...(Object.keys(reviewed.metadata).length === 0 ? {} : {metadata: reviewed.metadata}),
  }
}
