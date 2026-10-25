// Wallet / account convenience (A5): mnemonic → CIP-1852 account → addresses +
// signing keys, composed over the Keys + Address facades. Ergonomic entry point
// for wallets/dApps; all derivation is byte-exact (== CSL).

import type {Bech32, KeyHashHex, XprvHex} from '@evolution-sdk/review/Brands'
import {Effect} from 'effect'
import * as Address from './Address.js'
import * as Keys from './Keys.js'
import type {CoreError} from './Op.js'

/** ⚠️ No service requirement. These used to carry `Codec` in their R channel; see `Op.op`. */
type Eff<A> = Effect.Effect<A, CoreError>

/**
 * A CIP-1852 account.
 *
 * ⚠️ **This object holds live key material.** `rootXprv` and the `paymentKey` /
 * `stakeKey` results are extended PRIVATE keys as plain hex. Two honest limits of
 * doing this in a GC'd runtime, worth knowing rather than pretending otherwise:
 *
 * - **No zeroization.** JS strings are immutable and interned; there is no way to
 *   wipe one, and copies persist until GC. A JS library cannot fix this — key custody
 *   belongs in an enclave / secure element, with this type used only for the brief
 *   window an operation needs. See `Signer.SignerTag` for the seam a hardware or
 *   enclave signer implements *without* handing keys to this layer at all.
 * - **Accidental disclosure IS defended.** `rootXprv` is non-enumerable, and both
 *   `toJSON()` and Node's inspect hook redact it, so `JSON.stringify(account)`,
 *   `console.log(account)`, spreads and naive property walks cannot leak it. What
 *   remains is a caller explicitly reading a key and then logging it themselves.
 */
export interface Account {
  /**
   * The root extended PRIVATE key (hex). Non-enumerable and redacted from
   * `toJSON`/inspect — never log it, and prefer `paymentKey`/`stakeKey` so the
   * derivation path is explicit.
   */
  readonly rootXprv: XprvHex
  readonly accountIndex: number
  /** xprv of the external payment key at role 0, `index`. PRIVATE key material. */
  readonly paymentKey: (index?: number) => Eff<XprvHex>
  /** xprv of the stake key (role 2, index 0). PRIVATE key material. */
  readonly stakeKey: Eff<XprvHex>
  /** 28-byte payment key hash at role 0, `index`. */
  readonly paymentKeyHash: (index?: number) => Eff<KeyHashHex>
  readonly stakeKeyHash: Eff<KeyHashHex>
  /** base address (payment role 0/`index` + stake) bech32, for `network`. */
  readonly baseAddress: (network: Address.Network, index?: number) => Eff<Bech32>
  /** enterprise (payment-only) address bech32. */
  readonly enterpriseAddress: (network: Address.Network, index?: number) => Eff<Bech32>
  /** reward (stake) address bech32. */
  readonly rewardAddress: (network: Address.Network) => Eff<Bech32>
}

/** Build an account view from a root xprv. */
export const fromRoot = (rootXprv: XprvHex, accountIndex = 0): Account => {
  const paymentKey = (index = 0) => Keys.deriveCip1852(rootXprv, accountIndex, 0, index)
  const stakeKey = Keys.deriveCip1852(rootXprv, accountIndex, 2, 0)
  const paymentKeyHash = (index = 0) => paymentKey(index).pipe(Effect.flatMap(Keys.keyHashOf))
  const stakeKeyHash = stakeKey.pipe(Effect.flatMap(Keys.keyHashOf))
  const baseAddress = (network: Address.Network, index = 0) =>
    Effect.all([paymentKeyHash(index), stakeKeyHash]).pipe(
      Effect.flatMap(([pay, stake]) => Address.toBech32(Address.baseHex(network, pay, stake))),
    )
  const enterpriseAddress = (network: Address.Network, index = 0) =>
    paymentKeyHash(index).pipe(Effect.flatMap((pay) => Address.toBech32(Address.enterpriseHex(network, pay))))
  const rewardAddress = (network: Address.Network) =>
    stakeKeyHash.pipe(Effect.flatMap((stake) => Address.toBech32(Address.rewardHex(network, stake))))
  const account = {
    accountIndex,
    paymentKey,
    stakeKey,
    paymentKeyHash,
    stakeKeyHash,
    baseAddress,
    enterpriseAddress,
    rewardAddress,
    // Redact on the two paths that leak key material by ACCIDENT rather than by a
    // caller asking for it: `JSON.stringify` (crash reporters, structured logs,
    // request/state dumps) and `util.inspect` (`console.log(account)`, Node/bun REPL,
    // RN dev tooling). Cheap, and it covers the realistic disclosure route.
    toJSON: () => ({accountIndex, rootXprv: '[redacted]'}),
    [Symbol.for('nodejs.util.inspect.custom')]: () => `Account { accountIndex: ${accountIndex}, rootXprv: [redacted] }`,
  }
  // Non-enumerable so a spread / `Object.keys` / naive property walk cannot copy the
  // root key out. Still readable as `account.rootXprv` — the derivation needs it, and
  // hiding it behind a getter would only move the problem.
  Object.defineProperty(account, 'rootXprv', {value: rootXprv, enumerable: false, writable: false})
  return account as unknown as Account
}

/** Build an account straight from a BIP-39 mnemonic (Icarus root, empty password). */
export const fromMnemonic = (phrase: string, accountIndex = 0, passwordHex = '') =>
  Keys.rootKeyFromMnemonic(phrase, passwordHex).pipe(Effect.map((root) => fromRoot(root, accountIndex)))
