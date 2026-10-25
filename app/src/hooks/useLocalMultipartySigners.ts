/**
 * Which local wallet can answer a multiparty roster.
 *
 * The multisig counterpart is `useLocalCoSigners`, and it cannot serve here: it matches a
 * shared wallet's roster against cached CIP-1854 account xpubs and returns `[]` when there
 * is no `SharedWallet`. A multiparty signer is an ordinary wallet identified by the payment
 * key hash behind its inputs, so the lookup goes through addresses instead — see
 * {@link useLocalWalletKeys}, which the pending inbox shares so the two agree about whose
 * transaction this is.
 *
 * Read-only wallets are listed as `canSign: false` rather than filtered out there, because
 * the rule that matters lives in {@link localMultipartySignersOf} and is worth having in
 * one place: Alice watching Bob holds his key hashes and matches his row perfectly, and
 * must never be offered his signature.
 *
 * @module
 */

import type {EnvelopeSigner} from '../services/cardano/cosign/types'
import {type LocalMultipartySigner, localMultipartySignersOf} from '../services/cardano/multiparty/local-signers'
import {useLocalWalletKeys} from './useLocalWalletKeys'

export const useLocalMultipartySigners = (signers: readonly EnvelopeSigner[]): readonly LocalMultipartySigner[] =>
  localMultipartySignersOf(signers, useLocalWalletKeys())
