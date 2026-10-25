/**
 * Which NIGHT a DUST registration spends to back its own fee.
 *
 * Its own module because it is pure and because getting it wrong is invisible until a node refuses the
 * transaction: `./register-dust.ts` opens the vault and reaches the bridge, and neither of those is the
 * part worth testing.
 *
 * ## Why a registration spends NIGHT at all
 *
 * The ledger backs `allow_fee_payment` only with NIGHT the registration **itself spends in its
 * guaranteed unshielded offer** (`generationless_fee_availability`). NIGHT merely held by the wallet
 * counts for nothing, so an offerless registration is refused as `InsufficientDustForRegistrationFee`
 * no matter the balance. The UTxOs picked here are spent straight back to their own owner; the transfer
 * is a formality, the point is putting them where the ledger looks.
 *
 * ## Why already-generating NIGHT is excluded
 *
 * The ledger's filter is per-UTxO, not per-key: an input whose `initial_nonce` is already in
 * `generation.night_indices` contributes **zero** to the availability sum. The indexer reports the same
 * fact as `registeredForDustGeneration`, so a UTxO carrying it is dead weight here — it would occupy
 * one of the four slots and back nothing. A wallet whose NIGHT is *all* generating therefore has
 * nothing to register, which is the correct answer rather than a failure.
 *
 * ## Why so few
 *
 * They must go in the **guaranteed** segment — the ledger reads no other — and NIGHT inputs there each
 * cost ~2.4 ms of the 15 ms time-to-dismiss budget, so about four saturate it. That is the same ceiling
 * `./input-selection.ts` exists to avoid for transfers, met head-on here because there is no choice.
 *
 * @module
 */

import type {UnshieldedUtxo} from './wallet/unshielded-utxo-set'
import {NIGHT_TOKEN_TYPE} from './wallet/unshielded-utxo-set'

/**
 * How many NIGHT UTxOs a registration may spend.
 *
 * Four, from the measurement in `docs`/`@pnyx/midnight-native`: a NIGHT input obliges the ledger to
 * update dust-generation bookkeeping (~2.4 ms of synthetic cost) and only the guaranteed segment is
 * charged against the 15 ms floor. A fifth input does not make the registration bigger — it makes it
 * rejected.
 */
export const MAX_REGISTRATION_INPUTS = 4

/**
 * The NIGHT this registration should spend, largest first.
 *
 * Largest first because the fee allowance a UTxO can back scales with its value, so the fewest inputs
 * carrying the most projection is strictly the best pick under a hard input ceiling.
 *
 * Returns an empty list when there is no eligible NIGHT — an honest empty rather than a throw, because
 * the caller has to tell "nothing left to register" apart from "could not read the wallet", and only
 * one of those is an error.
 */
export const registrationInputs = (utxos: readonly UnshieldedUtxo[]): readonly UnshieldedUtxo[] =>
  utxos
    .filter((utxo) => utxo.tokenType === NIGHT_TOKEN_TYPE && !utxo.registeredForDustGeneration)
    .slice()
    .sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))
    .slice(0, MAX_REGISTRATION_INPUTS)
