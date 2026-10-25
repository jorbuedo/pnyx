/**
 * The Cardano codec seam and the typed tiers a wallet composes a transaction from.
 *
 * ⚠️ **There is no codec here, and no codec behind here either.** The tiers call Evolution's own
 * modules directly — `Certificate`, `NativeScripts`, `VotingProcedures`, `Bip32PrivateKey`,
 * `cose/SignData`, `TransactionBody.fromEncoded`. Every tier operation used to go through a
 * 109-operation `Codec` service supplied from the Effect context, so every tier's Effect carried
 * `Codec` in its R channel and a caller had to provide a layer to run one. The requirement is
 * `never` now.
 *
 * Each tier is a thin named surface: `Address` builds and reads addresses, `Keys` derives and
 * signs, `Wallet` turns an account root into the addresses a wallet watches, and `Certs` /
 * `Scripts` / `Meta` / `Body` / `Data` / `Tx` / `Gov` / `Cose` cover the rest of what a body
 * carries. They are hex in, hex out, and they return `Effect`s: Evolution's leaves throw on
 * malformed input and `Op.op` turns a throw into a typed failure exactly once, so a caller
 * composes these without a try/catch anywhere.
 *
 * Why a tier at all, rather than calling the primitives directly: the primitives are shaped for
 * correctness and these are shaped for the thing a wallet actually does. `Address.baseHex(net,
 * payment, stake)` is one call where assembling a header byte and two credentials by hand is four,
 * and the four are where a wrong network id or a swapped credential gets in.
 *
 * ⚠️ **This package is Pnyx's, deliberately.** It was lifted into the Evolution fork as two
 * packages while the switch was in progress: this is the *consuming* wallet's seam, shaped for
 * what a wallet does rather than for what is correct in general, and upstream has its own domain
 * types. It came back here as one package rather than two, because the split only ever described
 * which tier arrived when. See `docs/CARDANO_CORE.md`.
 *
 * @module
 */

export * as Address from './Address.js'
export * as Body from './Body.js'
export * as Certs from './Certs.js'
export * as Cose from './Cose.js'
export * as Data from './Data.js'
export * as Gov from './Gov.js'
export * as Keys from './Keys.js'
export * as Meta from './Meta.js'
export * as Op from './Op.js'
export * as Scripts from './Scripts.js'
export * as Tx from './Tx.js'
export * as Wallet from './Wallet.js'
