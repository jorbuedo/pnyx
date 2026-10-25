/**
 * UTXO variant Ledger app factories.
 *
 * Litecoin, Dogecoin, and Bitcoin Cash all use the Bitcoin Ledger app
 * with chain-specific configuration (currency, additionals, sigHashType).
 *
 * @module
 */

import type {LedgerTransport} from '../types'
import {createBitcoinLedgerApp} from './bitcoin'

/**
 * Creates a Litecoin Ledger app wrapper.
 *
 * Uses the Bitcoin Ledger app with `currency: 'litecoin'`.
 *
 * @param transport - Ledger transport
 */
export const createLitecoinLedgerApp = (transport: LedgerTransport) =>
  createBitcoinLedgerApp(transport, {currency: 'litecoin'})

/**
 * Creates a Dogecoin Ledger app wrapper.
 *
 * Uses the Bitcoin Ledger app with `currency: 'dogecoin'`.
 *
 * @param transport - Ledger transport
 */
export const createDogecoinLedgerApp = (transport: LedgerTransport) =>
  createBitcoinLedgerApp(transport, {currency: 'dogecoin'})

/**
 * Creates a Bitcoin Cash Ledger app wrapper.
 *
 * Uses the Bitcoin Ledger app with `currency: 'bitcoin_cash'`,
 * `additionals: ['abc']` for the ABC fork, and `sigHashType: 0x41`
 * for SIGHASH_ALL | SIGHASH_FORKID.
 *
 * @param transport - Ledger transport
 */
export const createBitcoinCashLedgerApp = (transport: LedgerTransport) =>
  createBitcoinLedgerApp(transport, {currency: 'bitcoin_cash', additionals: ['abc'], sigHashType: 0x41})

export type LitecoinLedgerApp = ReturnType<typeof createLitecoinLedgerApp>
export type DogecoinLedgerApp = ReturnType<typeof createDogecoinLedgerApp>
export type BitcoinCashLedgerApp = ReturnType<typeof createBitcoinCashLedgerApp>
