/**
 * Contract between the background dApp router and the app (side panel / popup).
 *
 * The background answers CIP-30 *reads* itself from a wallet snapshot the app
 * publishes to `chrome.storage.local`; *connect* and *signing* are delegated to
 * the app UI via broadcasts, with the decision returned over `chrome.runtime`.
 * See `docs/EXTENSION.md`.
 *
 * @module
 */

/** Storage key the app writes the active Cardano account's read snapshot to. */
export const DAPP_SNAPSHOT_KEY = 'pnyx.dapp.snapshot'

/** Storage key for the set of connected dApp origins. */
export const DAPP_SESSIONS_KEY = 'pnyx.dapp.sessions'

/** JSON-safe UTxO (bigints as decimal strings) as persisted in the snapshot. */
export type SnapshotUtxo = {
  readonly txHashHex: string
  readonly index: number
  readonly addressHex: string
  readonly coin: string
  readonly assets: ReadonlyArray<{readonly policyHex: string; readonly nameHex: string; readonly quantity: string}>
}

/**
 * The active Cardano account's data needed to answer CIP-30 read methods, as
 * published by the app. Addresses are raw-address hex (CIP-30 wire form).
 *
 * `groupId` + `accountIndex` identify the wallet group and derived account this
 * snapshot describes, so the router can require a grant for exactly that pair —
 * switching wallet or account therefore drops a dApp's access until it
 * reconnects.
 */
export type DappSnapshot = {
  readonly groupId: string
  /** Which derived account of the group the snapshot describes. */
  readonly accountIndex: number
  readonly networkId: number
  readonly networkMagic: number
  readonly usedAddressHexes: ReadonlyArray<string>
  readonly unusedAddressHexes: ReadonlyArray<string>
  readonly changeAddressHex: string
  readonly rewardAddressHexes: ReadonlyArray<string>
  readonly utxos: ReadonlyArray<SnapshotUtxo>
  readonly collateralUtxos: ReadonlyArray<SnapshotUtxo>
  // CIP-95 governance keys — absent until derived (first signing ceremony).
  readonly pubDRepKeyHex?: string
  readonly registeredPubStakeKeyHexes?: ReadonlyArray<string>
  readonly unregisteredPubStakeKeyHexes?: ReadonlyArray<string>
}

/** Background → app: navigate to an approval surface. */
export type NavigateMessage =
  | {readonly type: 'NAVIGATE_CONNECT_DAPP'; readonly origin: string}
  | {
      readonly type: 'NAVIGATE_CONFIRM_SIGN'
      readonly requestId: string
      readonly signType: 'tx' | 'data'
      readonly origin: string
    }

/**
 * App → background: the user's connect decision for an origin. `groupId` is the
 * wallet group the user approved for and is required on approval — the grant is
 * scoped to it, together with the account index. `ttlMs` is the lifetime the user
 * chose; `null` means the grant lasts until they revoke it.
 */
export type ConnectDecision = {
  readonly type: 'DAPP_CONNECT_DECISION'
  readonly origin: string
  readonly approved: boolean
  readonly groupId?: string
  readonly accountIndex?: number
  readonly ttlMs?: number | null
}

/**
 * App → background: the signing result for a request. `result` is the CIP-30
 * return value (a witness-set hex for tx, a DataSignature for data); `error`
 * carries a CIP-30 code/message on rejection or failure.
 */
export type SignDecision = {
  readonly type: 'DAPP_SIGN_DECISION'
  readonly requestId: string
  readonly result?: unknown
  readonly error?: {readonly code: number; readonly message: string}
}

/** App → background: submit a signed tx through the app's Cardano rail. */
export type SubmitRequest = {readonly type: 'DAPP_SUBMIT_TX'; readonly signedTxHex: string}
