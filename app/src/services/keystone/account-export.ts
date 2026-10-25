/**
 * Publishing our Cardano accounts as `crypto-multi-accounts`, so a companion wallet can watch
 * them without ever holding a key that can spend.
 *
 * Pure: the enclave ceremony that produces the root key belongs to the screen, and everything
 * from the key bytes onward is a shaping decision that should be testable without one.
 *
 * **Settled 2026-08-07 by the Eternl session.** It accepted the export and displayed both account
 * keys byte-for-byte as we derive them for the `abandon … about` mnemonic, which is only possible
 * if the `keyData`/`chainCode` split and the `hash160`-derived master fingerprint are both right.
 * Those two guesses are closed.
 *
 * ⚠️ **Still unconfirmed: `use_info` (305) numbering.** Emitted (SLIP-44 type 1815 plus the
 * network), because it is the only place an export can say which network its xpubs are for — a
 * reader otherwise has to guess between `addr1…` and `addr_test1…`. What is unconfirmed is the
 * direction: BCR-2020-007 numbers `mainnet = 0`, the inverse of Cardano's own network id, and a
 * wallet that read it the other way round would offer testnet addresses for a mainnet account.
 *
 * @module
 */

import {hash160} from '@pnyx/crypto'
import {
  bcrNetwork,
  COIN_TYPE_CARDANO,
  type ExportedHdKey,
  encodeMultiAccounts,
  type MultiAccounts,
  type QrHardwareCall,
} from '@pnyx/ur'

/** BIP32-Ed25519 public keys and chain codes are both 32 bytes; an account xpub is the pair. */
const KEY_BYTES = 32

/** CIP-1852 — the ordinary payment/staking account chain. */
export const CARDANO_PURPOSE_STANDARD = 1852
/** CIP-1854 — the multisig chain. Eternl asks for this alongside 1852 in one call. */
export const CARDANO_PURPOSE_MULTISIG = 1854
export const CARDANO_COIN_TYPE = 1815

/** The purposes we can answer for. A path under any other is a request we decline, not one we guess at. */
const EXPORTABLE_PURPOSES: readonly number[] = [CARDANO_PURPOSE_STANDARD, CARDANO_PURPOSE_MULTISIG]

/**
 * The master key's fingerprint (`xfp`) — the value every exported key is filed under, and what a
 * companion wallet later quotes back in a sign request so we can tell its requests from another
 * device's.
 */
export const masterFingerprintOf = (rootPublicKey: Uint8Array): number => {
  const digest = hash160(rootPublicKey)
  // Big-endian, matching BIP-32's "first four bytes read as a uint32". `>>> 0` keeps it unsigned;
  // without it a leading byte ≥ 0x80 would arrive as a negative number and encode as a CBOR
  // negative integer.
  return (((digest[0] ?? 0) << 24) | ((digest[1] ?? 0) << 16) | ((digest[2] ?? 0) << 8) | (digest[3] ?? 0)) >>> 0
}

/** One account-level key to publish: which chain it is on, which account, and the key itself. */
export type AccountKeySource = {
  /** CIP-1852 or CIP-1854. Required, because the path we publish is how a reader tells them apart. */
  readonly purpose: number
  readonly accountIndex: number
  /** The account-level extended public key: 32-byte public key followed by 32-byte chain code. */
  readonly xpub: Uint8Array
}

/** An account a caller wants, resolved from a path we recognised. */
export type RequestedAccount = {
  readonly purpose: number
  readonly accountIndex: number
}

export type RequestedAccounts = {
  readonly accepted: readonly RequestedAccount[]
  /** Paths we will not answer, with why — shown so a failed handshake is not silent. */
  readonly declined: readonly string[]
}

const formatPath = (components: readonly {readonly index: number; readonly hardened: boolean}[]): string =>
  `m${components.map((c) => `/${c.index}${c.hardened ? "'" : ''}`).join('')}`

/**
 * Read a `qr-hardware-call` as a list of accounts to export.
 *
 * Deliberately strict about the shape: exactly three hardened components, Cardano's coin type, and
 * a purpose we actually derive. A caller asking for anything else is declined by name rather than
 * approximated — publishing a key from a path nobody asked for is how a companion ends up watching
 * the wrong account, and the failure would surface as "no funds" long after the handshake.
 */
export const requestedAccountsFrom = (call: QrHardwareCall): RequestedAccounts => {
  const accepted: RequestedAccount[] = []
  const declined: string[] = []

  for (const schema of call.schemas) {
    const {components} = schema.keyPath
    const path = formatPath(components)
    const [purpose, coinType, account] = components

    if (components.length !== 3 || purpose === undefined || coinType === undefined || account === undefined) {
      declined.push(`${path}: not an account-level path`)
      continue
    }
    if (!purpose.hardened || !coinType.hardened || !account.hardened) {
      declined.push(`${path}: account-level components must be hardened`)
      continue
    }
    if (coinType.index !== CARDANO_COIN_TYPE) {
      declined.push(`${path}: not Cardano`)
      continue
    }
    if (!EXPORTABLE_PURPOSES.includes(purpose.index)) {
      declined.push(`${path}: unsupported purpose`)
      continue
    }
    // A caller may legitimately list the same path twice; publishing it twice would not.
    if (accepted.some((a) => a.purpose === purpose.index && a.accountIndex === account.index)) continue
    accepted.push({purpose: purpose.index, accountIndex: account.index})
  }

  return {accepted, declined}
}

/**
 * Build the export payload.
 *
 * ⚠️ **Key order is load-bearing, and this function must not impose one.** Eternl assigns the keys
 * it receives by position and ignores the `origin` path each one carries — two runs on 2026-08-07,
 * same mnemonic, settle it: answering its call in the order asked (1854 then 1852) imported
 * correctly, while the unsolicited export's 1852-then-1854 came back with the chains swapped and
 * the multisig receive address under the ordinary account. A correct `origin` changed nothing in
 * either direction.
 *
 * So the caller's order is the wire order, deliberately. The scanned path answers in the order the
 * call listed, which is the only order that path can defend.
 *
 * `name` is supplied by the caller rather than composed here so the label a companion wallet
 * shows in its account list goes through i18n like every other user-facing string.
 */
export const cardanoMultiAccounts = (params: {
  readonly masterFingerprint: number
  readonly accounts: readonly AccountKeySource[]
  readonly name: (account: RequestedAccount) => string
  /** Cardano's network id (0 testnet / 1 mainnet) — converted to BCR's inverted numbering here. */
  readonly cardanoNetworkId: number
  readonly device?: string
}): MultiAccounts => {
  const keys: ExportedHdKey[] = params.accounts.map((account) => {
    if (account.xpub.length !== KEY_BYTES * 2) {
      throw new Error(`crypto-multi-accounts: account ${account.accountIndex} xpub is ${account.xpub.length} bytes`)
    }
    return {
      keyData: account.xpub.slice(0, KEY_BYTES),
      chainCode: account.xpub.slice(KEY_BYTES),
      useInfo: {type: COIN_TYPE_CARDANO, network: bcrNetwork(params.cardanoNetworkId)},
      origin: {
        components: [
          {index: account.purpose, hardened: true},
          {index: CARDANO_COIN_TYPE, hardened: true},
          {index: account.accountIndex, hardened: true},
        ],
        // The path we publish is rooted at the master key, so the ancestor whose fingerprint this
        // is IS the master key. `depth` is left out: BCR-2020-007 needs it only when the
        // components are elided, and they are not.
        sourceFingerprint: params.masterFingerprint,
      },
      name: params.name({purpose: account.purpose, accountIndex: account.accountIndex}),
    }
  })

  return {
    masterFingerprint: params.masterFingerprint,
    keys,
    ...(params.device === undefined ? {} : {device: params.device}),
  }
}

/** The CBOR a companion wallet scans. Throws rather than exporting an empty account list. */
export const encodeCardanoAccountExport = (accounts: MultiAccounts): Uint8Array => encodeMultiAccounts(accounts)
