/**
 * The signing audit record — what was signed, for whom, at whose request, and
 * under which approval.
 *
 * ### Why it exists
 *
 * Prevention (Phase 16 item 41's review→sign gate) can only fail silently. This is
 * the detection half of item 45 and the auditability requirement of item 39: an
 * unexplained signature has to be *visible* to the user even when every control in
 * front of it was bypassed. `docs/SIGNING_AUDIT.md` is the behaviour contract.
 *
 * ### What a caller may declare, and what it may not
 *
 * A producer declares only {@link SigningAuditContext} — a `purpose` drawn from a
 * closed union and an `origin`. Everything else (the subjects, the approval kind,
 * the outcome, the timestamp) is derived by the recorder from the request it
 * actually signed, so a call site cannot describe a signature as something other
 * than what it was. That is the same rule the review screen follows: render what
 * the bytes prove, never a summary the requester wrote.
 *
 * @module
 */

/**
 * Why a signature was produced. Closed on purpose: an entry's label must not be
 * authorable by a dApp, a remote agent, or a model, which is exactly what a free
 * `string` here would permit. Adding a member is the same kind of decision as
 * adding a bucket in `signing-entry-points.test.ts`.
 */
export type SigningPurpose =
  // ── funds wallets, reviewed on TxReviewScreen ──
  | 'send'
  | 'stake'
  | 'swap'
  | 'consolidate'
  | 'dust'
  | 'cosign'
  | 'dapp-tx'
  | 'dapp-message'
  /** A transaction scanned from another wallet's QR, with Pnyx acting as its air-gapped signer. */
  | 'air-gap'
  // ── ID slot, infra-exempt from review (Phase 16 item 41's locked decision) ──
  | 'koios-register'
  | 'steelswap-register'
  /** Login by proving control of an Pnyx identity row (docs/PNYX_IDENTITY_PLAN.md). */
  | 'identity-login'
  /**
   * Binding this device's push token to the identity that owns it. Same key and nonce store as
   * `identity-login`, distinct domain tag — a server-issued challenge over the token bytes, so it
   * carries no more reviewable meaning than a login does.
   */
  | 'device-push-binding'
  /**
   * Filing a bug report: CIP-8 over a domain-tagged digest of the uploaded body
   * (`services/bug-report/submit.ts`). Infra-exempt like the other ID-slot signatures — the
   * signed bytes are a hash and a nonce, so there is nothing a review could show the user that
   * the "send this report" button has not already asked.
   */
  | 'bug-report'
  /**
   * Asking a gated circle for an invite: CIP-8 over a server-issued challenge, asserting the stake
   * credential of a **funds wallet the person chose** (`services/circle-invite-ceremony.ts`).
   *
   * ⚠️ **Reviewed, not exempt — and it was exempt until 2026-09-11.** While the signer was the
   * identity's own stake key this was ID-slot infrastructure and classified accordingly. Then the
   * key changed: that one is never delegated and holds nothing, so it could not satisfy a real
   * requirement, and the person now picks one of their own wallets. A funds wallet is never exempt
   * (`docs/SIGNING_AUDIT.md`), and the reward address being asserted is exactly the kind of thing a
   * review exists to show — it is what decides whether the circle admits them.
   *
   * ⚠️ The stake key rather than the payment key, because control of the *stake credential* is
   * what makes the delegation and balance facts the attestor checks mean anything.
   */
  | 'circle-invite-request'

/**
 * How the user authorised this signature.
 *
 * - `reviewed` — they saw the subject on `TxReviewScreen` and confirmed it.
 * - `infra-exempt` — an ID-slot server challenge carrying no reviewable meaning,
 *   authorised by the unlock ceremony rather than by a per-signature review.
 *
 * Never a caller-supplied field: it is a total function of the purpose
 * ({@link approvalOfPurpose}), so a funds signature cannot be logged as though it
 * were infrastructure.
 */
export type ApprovalKind = 'reviewed' | 'infra-exempt'

/**
 * The approval each purpose carries. Exhaustive by type — a new purpose does not
 * compile until it is classified, which is the point.
 */
const APPROVAL_OF: Record<SigningPurpose, ApprovalKind> = {
  send: 'reviewed',
  stake: 'reviewed',
  swap: 'reviewed',
  consolidate: 'reviewed',
  dust: 'reviewed',
  cosign: 'reviewed',
  'dapp-tx': 'reviewed',
  'dapp-message': 'reviewed',
  'air-gap': 'reviewed',
  'koios-register': 'infra-exempt',
  'steelswap-register': 'infra-exempt',
  'identity-login': 'infra-exempt',
  'device-push-binding': 'infra-exempt',
  'bug-report': 'infra-exempt',
  'circle-invite-request': 'reviewed',
}

export const approvalOfPurpose = (purpose: SigningPurpose): ApprovalKind => APPROVAL_OF[purpose]

/** Whether a purpose signs for a funds wallet (as opposed to the ID slot). */
export const isFundsPurpose = (purpose: SigningPurpose): boolean => approvalOfPurpose(purpose) === 'reviewed'

/**
 * What a producer declares at the signing call site. Deliberately minimal: two
 * fields, both of which the producer is the only party that knows.
 */
export type SigningAuditContext = {
  readonly purpose: SigningPurpose
  /**
   * The requesting origin, or `null` when the user initiated the action in-app.
   *
   * Attacker-controlled whenever it is non-null, so it is stored verbatim and
   * rendered as unverified — never resolved to a name, never trusted to scope
   * anything.
   */
  readonly origin: string | null
}

/**
 * What one signature was over.
 *
 * Neither variant holds the signed bytes. A transaction body is large and already
 * recoverable from the chain by its hash; a `signData` payload can carry anything
 * the requester chose, so keeping it would turn an audit log into a store of
 * arbitrary third-party content. A digest is enough to prove later that a specific
 * payload is (or is not) the one that was signed.
 */
export type SigningSubject = SigningTransactionSubject | SigningMessageSubject

export type SigningTransactionSubject = {
  readonly kind: 'transaction'
  /** Present once the transaction was assembled and broadcast; absent for `signOnly`. */
  readonly txHash?: string
  /** SHA-256 of the signed body bytes — the identity of a `signOnly` witness set. */
  readonly bodyDigestHex: string
  /** CIP-30 `signTx`: a witness set was returned rather than a transaction broadcast. */
  readonly signOnly: boolean
}

/**
 * How to read a {@link SigningMessageSubject.signer}. The app signs messages with
 * three different kinds of identity, and flattening them into one "address" field
 * would mean storing a bech32 `mn_addr` in something named hex — so the shape says
 * which it is. This is also the seam CAIP-10 would land on if item 39 adopts it.
 */
export type SignerRefKind = 'pnyx-id' | 'cardano-address-hex' | 'mn-addr' | 'verifying-key-hex'

export type SigningMessageSubject = {
  readonly kind: 'message'
  /** SHA-256 of the payload bytes. The payload itself is deliberately not kept. */
  readonly payloadDigestHex: string
  readonly payloadByteLength: number
  /** Which identity asserted — read according to {@link signerKind}. */
  readonly signer: string
  readonly signerKind: SignerRefKind
}

/** Whether the ceremony's leg reached a signature, and what became of it. */
export type SigningOutcome = 'submitted' | 'signed' | 'failed'

/**
 * One entry. Append-only: entries are never edited after the ceremony settles,
 * because a mutable audit record is not one.
 */
export type SigningAuditEntry = {
  /** Stable list key, unique within the store. */
  readonly id: string
  /** Epoch ms at which the ceremony settled. */
  readonly at: number
  readonly purpose: SigningPurpose
  readonly approval: ApprovalKind
  readonly outcome: SigningOutcome
  readonly origin: string | null
  /**
   * Wallet group that signed. `null` for the ID slot, which is not a wallet group
   * — the absence is meaningful and is rendered as the identity, not as a missing
   * wallet.
   */
  readonly groupId: string | null
  readonly accountIndex: number | null
  /** One per leg, in ceremony order. Empty when the ceremony failed before any leg. */
  readonly subjects: readonly SigningSubject[]
  /** Why it failed. Present only on `outcome: 'failed'`. */
  readonly failureReason?: string
}
