/**
 * The app's funds-wallet chain roster.
 *
 * - **Cardano** (2026-07-18): first-class — its own accounts and
 *   `selectedAccountIndex`, full treatment through the Cardano rail.
 * - **Midnight** (2026-08-19): first-class too, now that the wallet can hold and
 *   send. It has an account xpub like the others (secp256k1 BIP-32 at
 *   `m/44'/2400'/account'`), but ⚠️ its *addresses* derive from role **secret**
 *   keys — there is no public-only path — so they are derived once while the
 *   mnemonic is in memory and persisted (`persistMidnightReceiveAddresses`).
 *   That is why a group created before this change cannot be upgraded by a
 *   read-time backfill; see `docs/MIDNIGHT_WALLET_ARCHITECTURE.md` §5.
 * - **BTC / EVM / SOL** stay receive + xpub only (the derive-only rail in
 *   `@pnyx/wallet`) — not first-class group chains.
 * - The Midnight forum **identity** is separate entirely: a dedicated
 *   enclave-vault slot (`pnyx-identity`), never a wallet group, and its funds
 *   and state must not mix with a funds group's. See `identity-wallet.ts`.
 *
 * @module
 */

import {CARDANO_MAINNET, type ChainId, MIDNIGHT_MAINNET} from '@pnyx/config'

/** Chains a funds wallet group is created with as first-class wallet-group chains. */
export const FUNDS_CHAINS: readonly ChainId[] = [CARDANO_MAINNET, MIDNIGHT_MAINNET]
