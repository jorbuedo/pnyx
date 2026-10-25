/**
 * Feed the pure registration core from what the wallet has already synced.
 *
 * *Which* registrations exist needs no chain call at all: that is a fact about this
 * account's Cardano history, already in the store, and because the store is chain-derived
 * and keyed by the stake address it covers registrations made by any other wallet or tool
 * for the same keys.
 *
 * *Where each one sends DUST* does need the bytes, because the indexer's structured view
 * drops inline datums — but the datum is in the registering transaction, and the provider
 * can serve raw transaction CBOR (the tx-detail screen already relies on this). So it is one
 * small fetch keyed on the registrations we found, not a change to sync.
 *
 * @module
 */

import {Assets, TransactionHash} from '@evolution-sdk/evolution'
import {ValueHex} from '@evolution-sdk/review/Brands'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {Data, Effect} from 'effect'
import {logger} from '../../logger'
import {getCardanoDataStore} from '../cardano/cardano-store'
import {deserializeIndexedTx} from '../cardano/history-store'
import {NIGHT_ASSET_ID, NIGHT_POLICY_ID} from '../cardano/night-redeem'
import type {CardanoRail} from '../cardano/rail'
import {utxoAssetMap, utxoTxHashHex} from '../cardano/utxo-view'
import {decodeDustRegistrationDatum} from './registration-datum'
import type {CnightUtxo, RegistrationUtxo, StakeKeyHash} from './registration-health'
import {activeRegistrations, type ScanTx} from './registration-scan'

export class DustReadError extends Data.TaggedError('DustReadError')<{readonly reason: string}> {}

/** How many stored transactions to replay. Registration lifecycle events are rare. */
const SCAN_LIMIT = 500

const nightAssetName = NIGHT_ASSET_ID.split('.')[1] ?? ''

/**
 * Every stored transaction for this account, newest first, in the minimal shape the scan
 * needs.
 *
 * `IndexedIO` carries `tokens` as `{policyIdHex, assetNameHex}` pairs, which is what lets
 * the auth token be matched on policy **and** empty name rather than on a concatenated id —
 * the mapping validator is a multi-purpose script, so other tokens share its policy.
 */
const storedScanTxs = (rail: CardanoRail): Effect.Effect<readonly ScanTx[], DustReadError> =>
  Effect.gen(function* () {
    const store = getCardanoDataStore()
    if (store === null) return []
    const rows = yield* store.listTxRows({...rail.dataRef, limit: SCAN_LIMIT}).pipe(
      Effect.catchAll((e) => {
        logger.warn('Stored history read failed; the DUST scan sees no registrations', {
          origin: 'DustReadRegistrations',
          error: String(e),
        })
        return Effect.succeed([])
      }),
    )

    const out: ScanTx[] = []
    for (const row of rows) {
      const full = yield* store.getTxRow(rail.dataRef, row.hash).pipe(
        Effect.catchAll((e) => {
          logger.warn('Stored tx read failed; skipping it in the DUST scan', {
            origin: 'DustReadRegistrations',
            hash: row.hash,
            error: String(e),
          })
          return Effect.succeed(null)
        }),
      )
      if (!full?.detailJson) continue
      try {
        const tx = deserializeIndexedTx(full.detailJson)
        out.push({
          hash: tx.hash,
          ...(tx.slot !== undefined ? {slot: tx.slot} : {}),
          inputs: tx.inputs.map((io) => ({
            tokens: io.tokens.map((t) => ({policyIdHex: t.policyIdHex, assetNameHex: t.assetNameHex})),
            ...(io.outpoint !== undefined ? {outpoint: {txHash: io.outpoint.txHashHex, index: io.outpoint.index}} : {}),
          })),
          outputs: tx.outputs.map((io) => ({
            tokens: io.tokens.map((t) => ({policyIdHex: t.policyIdHex, assetNameHex: t.assetNameHex})),
            ...(io.outpoint !== undefined ? {outpoint: {txHash: io.outpoint.txHashHex, index: io.outpoint.index}} : {}),
          })),
        })
      } catch (e: unknown) {
        // A corrupt row is skipped; the next sync refills it. Silently, a sync that skipped every
        // row and one that found none both report no registrations.
        logger.warn('DUST registration row could not be read; skipping it', {
          origin: 'midnight-dust/read-registrations',
          error: String(e),
        })
      }
    }
    return out
  })

/**
 * Fill in each registration's DUST destination from the bytes of the transaction that
 * created it.
 *
 * The indexer's structured view drops inline datums, but the datum is *in the transaction*,
 * and the provider can serve raw transaction CBOR — the tx-detail screen already fetches and
 * decodes it for exactly this reason. So the destination is recoverable without any change
 * to sync: fetch the registering transaction, read the output at the registration's index,
 * decode its inline datum.
 *
 * This is also where ownership finally gets checked. The history scan can only say "this
 * account's transactions moved the auth token"; the datum is what names the stake key the
 * registration is *for*, so a registration naming someone else is dropped here.
 *
 * Registrations are rare — at most a handful — so this is a small, bounded fetch, and it is
 * skipped entirely when a provider cannot serve CBOR. A registration whose datum cannot be
 * read keeps `dustAddr: undefined` and is reported as unverified rather than guessed at.
 */
export const resolveRegistrationDatums = (
  rail: CardanoRail,
  regs: readonly RegistrationUtxo[],
  stakeKeyHash: StakeKeyHash,
): Effect.Effect<readonly RegistrationUtxo[], DustReadError> =>
  Effect.gen(function* () {
    const fetchCbor = rail.chain.getTxCbor
    if (fetchCbor === undefined || regs.length === 0) return regs

    const hashes = [...new Set(regs.map((r) => r.ref.txHash))].map((h) => TransactionHash.fromHex(h))
    const cbors = yield* fetchCbor(hashes).pipe(
      Effect.catchAll((e) => {
        logger.warn('Registration CBOR fetch failed; no datum can be resolved', {
          origin: 'DustReadRegistrations',
          txCount: hashes.length,
          error: String(e),
        })
        return Effect.succeed([])
      }),
    )

    type ResolvedOutput = {readonly datumHex: string | undefined; readonly valueHex: string}
    const outputsByTx = new Map<string, readonly ResolvedOutput[]>()
    for (const entry of cbors) {
      if (entry.cborHex === undefined || entry.cborHex.length === 0) continue
      const outputs = yield* Effect.gen(function* () {
        const bodyHex = yield* Inspect.txBodyFromTx(entry.cborHex)
        const {body} = yield* Inspect.txBody(bodyHex)
        // The value comes from the same decode as the datum: spending this registration
        // later needs it, and re-deriving it from constants would assume every registration
        // holds the min-ADA ours does.
        return body.outputs.map((o) => ({
          datumHex: o.inlineDatumHex,
          // ⚠️ Hex because that is what the spend path downstream carries, and `Assets.toCBORHex`
          // is byte-identical to the codec's value encoder this replaced (checked across seven
          // shapes including an empty asset name and an unsorted multi-policy bag).
          valueHex: ValueHex(
            Assets.toCBORHex(
              Assets.fromRecord({
                lovelace: o.value.amount,
                ...Object.fromEntries(o.value.tokens.map((t) => [`${t.policyIdHex}.${t.assetNameHex}`, t.amount])),
              }),
            ),
          ),
        }))
      }).pipe(
        Effect.catchAll((e) => {
          logger.warn('Registration tx did not decode; its outputs stay unresolved', {
            origin: 'DustReadRegistrations',
            hash: TransactionHash.toHex(entry.txHash),
            error: String(e),
          })
          return Effect.succeed<readonly ResolvedOutput[]>([])
        }),
      )
      outputsByTx.set(TransactionHash.toHex(entry.txHash).toLowerCase(), outputs)
    }

    const owner = stakeKeyHash.toLowerCase()
    const out: RegistrationUtxo[] = []
    for (const reg of regs) {
      const resolved = outputsByTx.get(reg.ref.txHash.toLowerCase())?.[reg.ref.index]
      const decoded = resolved?.datumHex === undefined ? null : decodeDustRegistrationDatum(resolved.datumHex)
      // Now that the datum is readable, a registration for another stake key is provably
      // not ours — the auth token merely passed through a transaction we took part in.
      if (decoded !== null && decoded.stakeKeyHash.toLowerCase() !== owner) continue
      const withValue = resolved === undefined ? reg : {...reg, valueHex: resolved.valueHex}
      out.push(decoded === null ? withValue : {...withValue, dustAddr: decoded.dustPayload})
    }
    return out
  })

/**
 * The account's active registrations, replayed from stored history and then resolved
 * against the registering transactions' own bytes so each one's DUST destination is known.
 */
export const readRegistrations = (
  rail: CardanoRail,
  stakeKeyHash: StakeKeyHash,
): Effect.Effect<readonly RegistrationUtxo[], DustReadError> =>
  Effect.gen(function* () {
    const txs = yield* storedScanTxs(rail)
    return yield* resolveRegistrationDatums(rail, activeRegistrations(txs, stakeKeyHash), stakeKeyHash)
  })

/**
 * The account's cNIGHT-bearing UTxOs with the slot each arrived, which is what decides
 * whether they generate: only cNIGHT received *after* the registration counts.
 *
 * The receipt slot is the slot of the transaction that created the UTxO, so this reads
 * current UTxOs and dates them from stored history. A UTxO whose creating transaction is not
 * in the scanned window is dated `null` — **not** `0`.
 *
 * That distinction is load-bearing. Dating it `0` made an unknown arrival read as "predates
 * the registration", which was justified as conservative on the grounds that an unnecessary
 * self-send is harmless. It is not harmless: it costs a real fee, and checking the four
 * verification wallets against the Midnight indexer on 2026-07-28 caught exactly this — a
 * wallet the indexer reports as generating (10 NIGHT eligible, positive rate) was being told
 * its NIGHT was inert and to pay to move it. Unknown means unknown, and no fee-bearing
 * remedy is recommended on a guess.
 */
export const readCnightUtxos = (rail: CardanoRail): Effect.Effect<readonly CnightUtxo[], DustReadError> =>
  Effect.gen(function* () {
    const utxos = yield* rail.confirmedUtxos
    const txs = yield* storedScanTxs(rail)
    const slotByTxHash = new Map(txs.map((tx) => [tx.hash.toLowerCase(), tx.slot ?? 0]))

    const out: CnightUtxo[] = []
    for (const utxo of utxos) {
      const held = utxoAssetMap(utxo)?.get(NIGHT_ASSET_ID)
      if (held === undefined || held <= 0n) continue
      const txHash = utxoTxHashHex(utxo)
      out.push({
        ref: {txHash, index: Number(utxo.index)},
        receiptSlot: slotByTxHash.get(txHash) ?? null,
        value: held,
      })
    }
    return out
  })

/** The NIGHT policy, re-exported so the UI can name what it is looking for. */
export {NIGHT_POLICY_ID, nightAssetName}
