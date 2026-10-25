/**
 * Recognising a NIGHT airdrop claim (Glacier "thaw") in a transaction.
 *
 * Claims come in two on-chain shapes, and both are the same thing to a user:
 *
 *  1. **First thaw** spends the **treasury** UTxO — one script holding the master
 *     NIGHT supply, proving allocation membership with a Merkle proof.
 *  2. **Every later thaw** spends the claimant's own **escrow** UTxO, created by
 *     the first thaw, with an empty redeemer.
 *
 * Both are matched on the spent input's **payment credential**, not on an
 * address. Yoroi checks one hardcoded treasury address, which cannot see escrow
 * thaws at all: the escrow is a *per-claimant* address — the escrow script hash
 * paired with the claimant's own stake credential — so there is one per holder
 * rather than one globally. (That pairing is also why an escrow UTxO shows up
 * under "Your escrows" in review without this module's help.)
 *
 * These hashes are our own deployment's constants (mirrored from the
 * `glacier-redeem` client), not a third-party registry — which is what makes
 * labelling this contract honest where a generic "known contract" label would
 * not be.
 *
 * @module
 */

import type {ReviewedTransaction} from '@pnyx/tx-review'

/**
 * PlutusV3 treasury script (mainnet) — holds the master NIGHT supply. Equals the
 * payment credential of the address Yoroi hardcodes as its redemption address.
 */
const TREASURY_SCRIPT_HASH = '9015199b65dff1a5b9e281192c0157c23ccb579311232b94fe1c037c'

/** PlutusV3 escrow script (mainnet) — holds a claimant's remaining thaws. */
const ESCROW_SCRIPT_HASH = '5986bfcc0cbfc60dec8df87715cc95d03817aac386b0e9d33da03b39'

const CLAIM_SCRIPT_HASHES: ReadonlySet<string> = new Set([TREASURY_SCRIPT_HASH, ESCROW_SCRIPT_HASH])

/**
 * `txReview.knownScripts.*` leaf key for a script hash, or `undefined`. Only our
 * own deployment's scripts are named here — see the module note on why a generic
 * "known contract" label would not be honest.
 */
export const knownScriptKey = (scriptHashHex: string): 'glacierTreasury' | 'glacierEscrow' | undefined =>
  scriptHashHex === TREASURY_SCRIPT_HASH
    ? 'glacierTreasury'
    : scriptHashHex === ESCROW_SCRIPT_HASH
      ? 'glacierEscrow'
      : undefined

/** NIGHT token policy id. */
export const NIGHT_POLICY_ID = '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa'
/** NIGHT asset name — utf-8 "NIGHT" as hex. */
export const NIGHT_ASSET_NAME_HEX = '4e49474854'
/** The NIGHT asset id in review-IR form. */
export const NIGHT_ASSET_ID = `${NIGHT_POLICY_ID}.${NIGHT_ASSET_NAME_HEX}`

/**
 * True when this transaction claims NIGHT from the airdrop — either shape.
 *
 * Requires *both* a claim script being spent and NIGHT actually moving: the
 * script check alone would mis-label an unrelated interaction with the same
 * contract, and NIGHT alone matches every ordinary NIGHT transfer and every DEX
 * trade (mainnet has NIGHT pools behind entirely different scripts).
 */
export const isNightClaim = (reviewed: ReviewedTransaction): boolean => {
  const spendsClaimScript = reviewed.inputs.some((io) => {
    const payment = io.credentials?.payment
    return payment?.type === 'script' && CLAIM_SCRIPT_HASHES.has(payment.hashHex)
  })
  if (!spendsClaimScript) return false
  return [...reviewed.inputs, ...reviewed.outputs].some((io) =>
    io.amounts.some((a) => a.assetId === NIGHT_ASSET_ID && a.quantity !== 0n),
  )
}
