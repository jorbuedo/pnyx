/**
 * The UTxO identity the overlay, the locked set and the pending tracker all key on.
 *
 * ⚠️ **Evolution's `UTxO` is the type, by decision (2026-10-11).** The Cardano UTxO path carries
 * Evolution's own types end to end; this package's former `WalletUtxo` — `txHash` as bytes,
 * `address` as bech32, `value.assets` as a `Map<"policy.name", bigint>` — was a *serialized* shape
 * held in the compute zone, decoded on the way in and re-encoded before every plan build.
 *
 * Seven other helpers lived here (`createWalletUtxo`, `parseUtxoId`, `getLovelace`, `getAsset`,
 * `isAdaOnly`, `sumLovelace`, `sumAssets`) and **none had a consumer**. `createWalletUtxo` was also
 * the only code that ever wrote `addressing` / `datumHash` / `datum` / `scriptRef`, so those fields
 * went with it rather than needing a home on the new type.
 *
 * @module
 */

import {TransactionHash, type UTxO} from '@evolution-sdk/evolution'

/**
 * `txHash:index` — the string key the overlay, the locked set and the pending tracker agree on.
 *
 * ⚠️ Lowercase hex and a decimal index, because this string is **persisted** and compared against
 * ids read back out of storage. `TransactionHash.toHex` answers lowercase; nothing may normalize
 * it differently without a migration.
 */
export const utxoId = (utxo: UTxO.UTxO): string => `${TransactionHash.toHex(utxo.transactionId)}:${utxo.index}`
