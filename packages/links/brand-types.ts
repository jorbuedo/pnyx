/**
 * Brand-specific link types for versioned partner deep links.
 *
 * These links use a brand-specific scheme (e.g. pnyx://) with
 * a brand link authority and versioned paths.
 *
 * Supported via:
 * - pnyx://pnyx.pxkq.uk/w1/<feature>/<useCase>?<params>
 * - https://pnyx.pxkq.uk/w1/<feature>/<useCase>?<params>
 *
 * @module
 */

/**
 * Chains accepted by `transfer/request/crypto` links. The list is intentionally
 * conservative — extending it requires verifying that downstream consumers know
 * how to route a send on that chain. Partners that need a new chain should
 * coordinate with the wallet team before sending links.
 *
 * The Cardano testnets are here because the wallet itself now *builds* these
 * links (Receive → Request funds), and a request the wallet can produce on the
 * network it is running on but not read back would be a link that only works in
 * production — untestable exactly where it needs testing most.
 */
export const KNOWN_TRANSFER_CHAINS = ['cardano:mainnet', 'cardano:preprod', 'cardano:preview', 'eip155:1'] as const

/**
 * CAIP-2 chain identifier accepted by `transfer/request/crypto`.
 */
export type KnownTransferChain = (typeof KNOWN_TRANSFER_CHAINS)[number]

/**
 * Partner/client-specific transfer normalizers supported by this package.
 */
export const TRANSFER_REQUEST_CLIENTS = ['encryptus'] as const

export type TransferRequestClient = (typeof TRANSFER_REQUEST_CLIENTS)[number]

/**
 * Partner callback surface hint. Partners that host a web widget can use this
 * to choose the correct return protocol for wallet callbacks:
 * - `web` → web protocol handler
 * - `app` → native mobile app deep link (`pnyx://...`)
 */
export type PartnerCallbackPlatform = 'web' | 'app'

/**
 * Target for a transfer request (one output in a transaction)
 */
export type TransferTarget = {
  readonly receiver: string
  readonly datum?: string
  readonly amounts: ReadonlyArray<{
    readonly tokenId: string
    readonly quantity: string
  }>
}

/**
 * Partner integration metadata included in brand deep links
 */
export type PartnerInfo = {
  /**
   * Optional partner/client identifier. When supported, builders and parsers
   * may normalize partner-specific transfer labels to canonical wallet values.
   */
  readonly client?: TransferRequestClient | (string & {})
  readonly isSandbox?: boolean
  readonly isTestnet?: boolean
  readonly appId?: string
  readonly message?: string
  readonly authorization?: string
  readonly signature?: string
  readonly callbackPlatform?: PartnerCallbackPlatform | (string & {})
  /**
   * Opaque wallet-group identifier the wallet may use to restore the source
   * wallet that initiated a partner handoff. Partners should echo it back
   * unchanged in follow-up callbacks such as `transfer/request/crypto`.
   */
  readonly sourceWalletGroupId?: string
  /**
   * Account index within `sourceWalletGroupId` that produced the handoff
   * address. Partners should echo it unchanged with `sourceWalletGroupId`.
   */
  readonly sourceWalletAccountIndex?: string
  /**
   * Raw HTTPS URL the wallet should redirect back to after the user finishes the
   * requested action. Pass unencoded — the builder applies URL-component
   * encoding once. The wallet preserves nested query parameters so partner
   * callbacks with `?orderId=...&coinType=...` etc. survive the round-trip.
   */
  readonly redirectTo?: string
}

/**
 * Transfer request with explicit targets (receiver, amounts, optional datum)
 */
export type TransferRequestAda = PartnerInfo & {
  readonly targets: ReadonlyArray<TransferTarget>
  readonly memo?: string
}

/**
 * Transfer request containing an embedded web+cardano:// link.
 *
 * @deprecated Prefer {@link TransferRequestCrypto} (`transfer/request/crypto`)
 * for new integrations. The chain-aware shape works for ADA and EVM in one
 * call and avoids the double-encoding step required to embed a CIP-13 URI.
 */
export type TransferRequestAdaWithLink = PartnerInfo & {
  readonly link: string
}

/**
 * Chain-aware transfer request for native or token sends.
 *
 * Amounts are expressed in the asset's base units:
 *   - ADA → lovelace (1 ADA = 1_000_000 lovelace)
 *   - ETH → wei (1 ETH = 10^18 wei)
 *   - Ethereum USDC → token base units (1 USDC = 1_000_000 units)
 *
 * Partner-specific normalizers may canonicalize labels like `chain=ETHEREUM`
 * and `name=USDC`, but they do not convert `amount`: callback links into the
 * wallet must already contain a base-unit integer string.
 *
 * Field semantics:
 *   - `chain`  — CAIP-2 identifier; see {@link KnownTransferChain}. The wallet
 *                rejects unrecognised chains.
 *   - `address`— recipient address in the chain's native format
 *                (`addr1…` for Cardano, `0x…` for EVM).
 *   - `amount` — base-unit integer string. Omit to let the user choose at the
 *                send-amount screen.
 *   - `token`  — asset identifier for non-native sends: contract address for
 *                EVM ERC-20s, `policyId.assetNameHex` for Cardano native
 *                tokens. Omit for the chain's native asset (ADA / ETH).
 *                Drives the wallet's asset selection.
 *   - `asset`  — optional display symbol (e.g. `"ADA"`, `"ETH"`) the partner
 *                wants the wallet to show. Passive metadata — does not affect
 *                routing.
 *   - `name`   — partner-specific asset-name alias. Supported client
 *                normalizers may map this into `asset` and `token`.
 */
export type TransferRequestCrypto = PartnerInfo & {
  // `KnownTransferChain | (string & {})` preserves IDE autocomplete for the
  // recommended values while still accepting any string the parser extracts
  // from the URL. Consumers should validate against `KNOWN_TRANSFER_CHAINS`.
  readonly chain: KnownTransferChain | (string & {})
  readonly address: string
  readonly amount?: string
  readonly token?: string
  readonly asset?: string
  readonly name?: string
}

/**
 * Exchange order result display
 */
export type ExchangeShowCreateResult = PartnerInfo & {
  readonly provider: string
  readonly orderType: 'buy' | 'sell'
  readonly coinAmount?: number
  readonly coin?: string
  readonly fiatAmount?: number
  readonly fiat?: string
  readonly status?: 'success' | 'pending' | 'failed'
}

/**
 * Launch a dApp URL in the in-app browser
 */
export type BrowserLaunchDappUrl = PartnerInfo & {
  readonly dappUrl: string
}

/**
 * A co-signer publishing their CIP-1854 shared account key so someone building
 * a shared wallet can add them.
 *
 * Nothing here is secret — a key hash or account xpub is public the moment the
 * wallet transacts. What the link has to get right is *authenticity*: the
 * receiving app shows `name` next to the key so the person adding it can see
 * whose key they are about to bind into a spending policy.
 */
/**
 * One co-signer key, and nothing else.
 *
 * It used to carry a display name and the CIP-1854 account index it was taken
 * at. Neither travels any more:
 *
 * - **The name is the builder's to type.** A name proposed by the sender is a
 *   string chosen by whoever is asking to be let into a spending policy, and it
 *   arrived pre-filled in the roster the builder was reviewing.
 * - **The account index decorated nothing.** Every address derives from the xpub
 *   itself, and the wallet records the *builder's* account index, not each
 *   sender's — so the field labelled a key without ever binding it.
 *
 * `name` and `accountIndex` stay readable so a link from an older build still
 * parses; nothing acts on them.
 */
export type MultisigCoSignerKey = PartnerInfo & {
  /** CIP-5 `acct_shared_xvk…` — the bech32 form, so a CIP-1852 key cannot pass. */
  readonly key: string
  /** @deprecated Read for compatibility with older builds; ignored. */
  readonly name?: string
  /** @deprecated Read for compatibility with older builds; ignored. */
  readonly accountIndex?: number
}

/**
 * An invitation to join a shared wallet, sent by whoever is assembling it. The
 * recipient answers with their own {@link MultisigCoSignerKey}.
 */
/**
 * An invitation to message someone.
 *
 * ⚠️ **The permit is the whole thing** — a signed token from the content service, and the only
 * credential involved. It names no bearer, so whoever opens the link converts it into a permit of
 * their own (`docs/ABUSE_MITIGATION.md` §5). It is therefore exactly as shareable as it looks: post
 * it in a circle and anyone in that circle can use it, which is the point.
 *
 * No issuer field: the token carries its own `sub`, and a separate copy in the URL could disagree
 * with it. The app reads the issuer out of the token rather than trusting the link.
 */
export type DmInvite = PartnerInfo & {
  /** The permit token, as issued by `POST /dm/permits` with no bearer. */
  readonly permit: string
}

/**
 * A whole shared-wallet definition, as one opaque payload.
 *
 * The roster is a list, and a URL cannot carry one without an indexing
 * convention that then has to be parsed defensively at the far end. Packing it
 * keeps this package a URL codec: it moves the string and never learns what a
 * script template is. The wallet layer owns the format and its validation —
 * `app/src/services/cardano/multisig/definition-link.ts`.
 *
 * Nothing in it is secret: public keys and a spending policy. The link lets the
 * holder watch the wallet, which reading the chain already allows, and spend
 * nothing without the quorum's private halves.
 */
export type MultisigWalletDefinition = PartnerInfo & {
  /** Versioned, base64url-packed definition. Opaque here by design. */
  readonly def: string
}

/**
 * A request for someone's co-signer key. It carries nothing.
 *
 * It used to name the wallet being built, name the sender, and carry an
 * `inviteId`. All three are gone:
 *
 * - **The wallet's name** told the recipient about a wallet that does not exist
 *   yet, and may never; the request is only ever "send me your key".
 * - **The sender's name** was the label of the sender's own *funds wallet* — an
 *   internal name they chose for their bookkeeping. The conversation already
 *   says who is asking.
 * - **`inviteId`** promised that a reply could be matched to the roster row
 *   waiting for it. Nothing read it, and the one call site hardcoded the
 *   conversation part, so it could not have distinguished two invitees anyway.
 */
export type MultisigInvite = PartnerInfo

/**
 * Parsed brand link action
 */
export type BrandAction =
  | {readonly feature: 'multisig'; readonly useCase: 'cosigner-key'; readonly params: MultisigCoSignerKey}
  | {readonly feature: 'multisig'; readonly useCase: 'invite'; readonly params: MultisigInvite}
  | {readonly feature: 'multisig'; readonly useCase: 'wallet'; readonly params: MultisigWalletDefinition}
  | {readonly feature: 'dm'; readonly useCase: 'invite'; readonly params: DmInvite}
  | {readonly feature: 'transfer'; readonly useCase: 'request/ada'; readonly params: TransferRequestAda}
  | {
      readonly feature: 'transfer'
      readonly useCase: 'request/ada-with-link'
      readonly params: TransferRequestAdaWithLink
    }
  | {
      readonly feature: 'transfer'
      readonly useCase: 'request/crypto'
      readonly params: TransferRequestCrypto
    }
  | {
      readonly feature: 'exchange'
      readonly useCase: 'order/show-create-result'
      readonly params: ExchangeShowCreateResult
    }
  | {readonly feature: 'browser'; readonly useCase: 'launch'; readonly params: BrowserLaunchDappUrl}
