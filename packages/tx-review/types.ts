/**
 * The review IR — one wallet-aware, data-only summary of "what this transaction
 * does to me", rendered by both the signing-review screen and activity/detail.
 * No formatting, no i18n, no display strings, no token metadata, no fiat: all
 * presentation enrichment is the consuming app's job.
 *
 * Modern shape: operations are a fully-EXTRACTED discriminated union
 * (pool ids, DReps, deposits, governance vote choices, proposal actions), and
 * the transaction carries the detail-tab fields (UTxOs, collateral, script data,
 * required signers, witness set, metadata) a full multi-tab review needs.
 *
 * Chain-agnostic on the outside (`chain` discriminant); Cardano is the only
 * producer today — future chains add operation members + a producer module.
 *
 * @module
 */

/**
 * Which of ours a credential belongs to. The forum identity and the funds
 * wallet are separate seeds: something addressed to the identity is still the
 * user's, but it is not spendable by the wallet that is signing.
 */
export type OwnerKind = 'wallet' | 'identity'

/**
 * How much of an address we control.
 *
 * - `own` — the **payment** credential is one of our keys: we can spend it.
 * - `escrow` — the payment credential is a **script** that delegates to our
 *   stake credential. We cannot spend it directly, but it is our position.
 * - `stake-hijack` — the payment credential is a **foreign key** carrying our
 *   stake credential. Not ours, and not benign: it is the shape of a mangled /
 *   delegation-hijack address, so it raises a warning.
 * - `none` — a counterparty.
 *
 * `escrow` and `stake-hijack` were one `'stake-only'` level until 2026-07-25,
 * which conflated "my position" with "someone else's address wearing my stake
 * key" — the reason for splitting them.
 */
export type Ownership =
  | {readonly level: 'own'; readonly owner: OwnerKind}
  | {readonly level: 'escrow'; readonly owner: OwnerKind}
  | {readonly level: 'stake-hijack'; readonly owner: OwnerKind}
  | {readonly level: 'none'}

/** The tier an {@link Ownership} sorts into. */
export type OwnershipLevel = Ownership['level']

/** An address as raw bytes + bech32 when representable. */
export type AddressRef = {
  readonly hex: string
  readonly bech32?: string
}

/**
 * One asset amount. `assetId` is `"<policyHex>.<assetNameHex>"`; absent means
 * the chain coin (lovelace). Negative quantities are outflows in delta
 * positions, burns in mint positions.
 */
export type ReviewedAmount = {
  readonly assetId?: string
  readonly quantity: bigint
}

/** A UTxO's identity: the transaction that created it, plus the output index. */
export type Outpoint = {
  readonly txHashHex: string
  readonly index: number
}

/** A classified input/output with its value. */
export type ReviewedIO = {
  readonly address: AddressRef
  readonly ownership: Ownership
  readonly amounts: readonly ReviewedAmount[]
  /**
   * The address's credentials, when the producer could inspect them (the CBOR
   * path can; the indexed/history path only has the address). Drives per-stake
   * party grouping and the address inspector.
   */
  readonly credentials?: {
    readonly payment?: ReviewedCredential
    readonly stake?: ReviewedCredential
  }
  /**
   * The UTxO this entry *is*. On an input it names the transaction that created
   * the UTxO being spent. On an output it names this transaction — so it is
   * legitimately absent while reviewing an unsigned transaction, whose hash does
   * not exist yet.
   */
  readonly outpoint?: Outpoint
  /**
   * A datum attached to the output — the data a script reads when the UTxO is
   * later spent. `inline` carries the datum itself; `hash` carries only its hash,
   * meaning the datum lives off-chain and this output cannot be interpreted
   * without it. The distinction is the point: an output whose datum is a bare
   * hash is opaque to the reader by construction, and saying so is honest.
   *
   * Only outputs have one, and only the CBOR path can see it.
   */
  readonly datum?: {readonly kind: 'hash'; readonly hashHex: string} | {readonly kind: 'inline'; readonly hex: string}
  /**
   * A reference script the output carries, so other transactions can use the
   * script without re-supplying its bytes. Rendered as a size, not as bytes —
   * these run to kilobytes.
   */
  readonly refScript?: {readonly hex: string}
  /**
   * This input spends an output of a transaction that is not on chain yet, so this
   * transaction is contingent on that one landing. If the parent is dropped this
   * one becomes unspendable by construction — the pending tracker even cascades
   * its rollback. Inputs only.
   */
  readonly fromUnconfirmedTx?: boolean
}

/** An input reference the wallet could not resolve to an address/value (foreign UTxO). */
export type InputRef = Outpoint

/** A per-asset signed delta (positive = net received, negative = net sent). */
export type ReviewedDelta = {
  readonly assetId?: string
  readonly delta: bigint
}

/**
 * Per-party aggregate: one entity's net sent/received across the tx. "Entity"
 * is either the active account (all its addresses) or a single external
 * counterparty. Amounts are netted per-asset — an asset is exclusively in
 * `sent` OR `received`, never both; zero-net omitted; quantities positive.
 */
export type PartyAggregate = {
  readonly ownership: Ownership
  /** Own aggregate: every own address the tx touched. External: exactly one. */
  readonly addresses: readonly AddressRef[]
  /**
   * The stake credential this party groups under: the shared one for our own
   * tiers, the delegation target for an escrow. Absent when the producer could
   * not inspect credentials, or for addresses that have no stake part.
   */
  readonly stakeCredHex?: string
  readonly sent: readonly ReviewedAmount[]
  readonly received: readonly ReviewedAmount[]
}

/**
 * Addresses grouped by ownership tier with per-group net deltas +
 * presentation-ready parties. See {@link ReviewedTransaction} for the four
 * tiers; within a group, our own tiers aggregate per stake credential and the
 * external tiers carry one party per address, in first-appearance order.
 */
export type AddressGroup = {
  readonly entries: readonly ReviewedIO[]
  readonly deltas: readonly ReviewedDelta[]
  readonly parties: readonly PartyAggregate[]
}

/** A credential (28-byte hash) that is either a key or a script. */
export type ReviewedCredential = {
  readonly hashHex: string
  readonly type: 'key' | 'script'
}

/** DRep target for vote delegation. Hash forms are rendered CIP-129/105 by the UI. */
export type ReviewedDRep =
  | {readonly type: 'key_hash'; readonly keyHashHex: string}
  | {readonly type: 'script_hash'; readonly scriptHashHex: string}
  | {readonly type: 'abstain'}
  | {readonly type: 'no_confidence'}

export type ReviewedAnchor = {readonly url: string; readonly dataHashHex: string}

/** A governance-action reference (proposal id): tx hash + cert/proposal index. */
export type ReviewedGovActionId = {readonly txHashHex: string; readonly index: number}

/** A voter casting a governance vote. */
export type ReviewedVoter =
  | {readonly role: 'drep'; readonly credential: ReviewedCredential}
  | {readonly role: 'committee_hot'; readonly credential: ReviewedCredential}
  | {readonly role: 'pool'; readonly keyHashHex: string}

/** A single governance vote: who, on which action, which way. */
export type ReviewedVote = {
  readonly voter: ReviewedVoter
  readonly govActionId: ReviewedGovActionId
  readonly choice: 'yes' | 'no' | 'abstain'
  readonly anchor?: ReviewedAnchor
}

/** The governance action a proposal enacts (essential user-facing fields, hex-encoded). */
export type ReviewedGovAction =
  | {
      readonly type: 'parameter_change'
      readonly prev?: ReviewedGovActionId
      readonly paramUpdateHex: string
      readonly policyHashHex?: string
    }
  | {readonly type: 'hard_fork'; readonly prev?: ReviewedGovActionId; readonly major: bigint; readonly minor: bigint}
  | {
      readonly type: 'treasury_withdrawals'
      readonly withdrawals: readonly {readonly rewardAccountHex: string; readonly amount: bigint}[]
      readonly policyHashHex?: string
    }
  | {readonly type: 'no_confidence'; readonly prev?: ReviewedGovActionId}
  | {
      readonly type: 'update_committee'
      readonly prev?: ReviewedGovActionId
      readonly removed: readonly ReviewedCredential[]
      readonly added: readonly {readonly credential: ReviewedCredential; readonly epoch: bigint}[]
      readonly threshold: readonly [bigint, bigint]
    }
  | {
      readonly type: 'new_constitution'
      readonly prev?: ReviewedGovActionId
      readonly anchor: ReviewedAnchor
      readonly scriptHashHex?: string
    }
  | {readonly type: 'info'}

/** A proposal procedure: deposit + reward account + the action + anchor. */
export type ReviewedProposal = {
  readonly deposit: bigint
  readonly rewardAccountHex: string
  readonly action: ReviewedGovAction
  readonly anchor: ReviewedAnchor
}

/** A minted/burned asset under a policy (negative quantity = burn). */
export type ReviewedMintAsset = {readonly assetNameHex: string; readonly quantity: bigint}

/**
 * The fully-extracted Cardano operation union. Each operation is a
 * user-verifiable statement of intent; deposits are resolved (cert field or
 * protocol param), never fabricated.
 */
export type CardanoOperation =
  | {readonly kind: 'stake-registration'; readonly credential: ReviewedCredential; readonly deposit: bigint}
  | {readonly kind: 'stake-deregistration'; readonly credential: ReviewedCredential; readonly deposit: bigint}
  | {readonly kind: 'stake-delegation'; readonly credential: ReviewedCredential; readonly poolKeyHashHex: string}
  | {readonly kind: 'vote-delegation'; readonly credential: ReviewedCredential; readonly drep: ReviewedDRep}
  | {
      readonly kind: 'stake-vote-delegation'
      readonly credential: ReviewedCredential
      readonly poolKeyHashHex: string
      readonly drep: ReviewedDRep
    }
  | {
      readonly kind: 'stake-reg-delegation'
      readonly credential: ReviewedCredential
      readonly poolKeyHashHex: string
      readonly deposit: bigint
    }
  | {
      readonly kind: 'vote-reg-delegation'
      readonly credential: ReviewedCredential
      readonly drep: ReviewedDRep
      readonly deposit: bigint
    }
  | {
      readonly kind: 'stake-vote-reg-delegation'
      readonly credential: ReviewedCredential
      readonly poolKeyHashHex: string
      readonly drep: ReviewedDRep
      readonly deposit: bigint
    }
  | {
      readonly kind: 'committee-hot-auth'
      readonly cold: ReviewedCredential
      readonly hot: ReviewedCredential
    }
  | {readonly kind: 'committee-cold-resign'; readonly cold: ReviewedCredential; readonly anchor?: ReviewedAnchor}
  | {
      readonly kind: 'drep-registration'
      readonly credential: ReviewedCredential
      readonly deposit: bigint
      readonly anchor?: ReviewedAnchor
    }
  | {readonly kind: 'drep-deregistration'; readonly credential: ReviewedCredential; readonly deposit: bigint}
  | {readonly kind: 'drep-update'; readonly credential: ReviewedCredential; readonly anchor?: ReviewedAnchor}
  | {readonly kind: 'pool-registration'; readonly poolKeyHashHex: string; readonly deposit: bigint}
  | {readonly kind: 'pool-retirement'; readonly poolKeyHashHex: string; readonly epoch: bigint}
  | {
      readonly kind: 'reward-withdrawal'
      readonly rewardAddress: AddressRef
      readonly amount: bigint
      readonly own: boolean
    }
  | {
      readonly kind: 'minting'
      readonly policyIdHex: string
      readonly assets: readonly ReviewedMintAsset[]
      readonly burns: boolean
    }
  | {readonly kind: 'voting-procedures'; readonly votes: readonly ReviewedVote[]}
  | {readonly kind: 'proposal-procedures'; readonly proposals: readonly ReviewedProposal[]}
  | {
      readonly kind: 'contract-execution'
      readonly scriptDataHashHex: string
      readonly collateralInputs: number
      readonly totalCollateral?: bigint
    }
  | {
      readonly kind: 'unknown-certificate'
      /** The CBOR array tag, when decoded from bytes. */
      readonly tag?: number
      /** The indexer's name for it, when that is all we have. */
      readonly label?: string
    }

export type ReviewedOperation = CardanoOperation

export type TransactionWarning =
  | 'large-fee'
  /** Sub-min-ada change was folded into the fee instead of returned. */
  | 'change-folded-into-fee'
  | 'no-ttl'
  | 'minting'
  | 'burning'
  | 'plutus-contract'
  | 'governance-action'
  | 'unknown-certificate'
  | 'script-certificate'
  | 'unresolved-inputs'
  | 'unknown-body-fields'
  | 'treasury-donation'
  | 'multi-sig'
  /** An address reuses our stake credential under someone else's payment key. */
  | 'stake-credential-reuse'
  /**
   * The transaction spends a UTxO of ours whose stake credential is not ours — a
   * multi-delegation address — and puts nothing back at that same credential.
   *
   * We hold the payment key, so the spend is entirely legitimate; what ends is the
   * *delegation*. Those coins were deliberately parked under a stake key pointing at
   * one pool, and consolidating them onto the primary address moves them under this
   * wallet's own stake key. Nothing warns about it on-chain and the amounts alone do
   * not show it, so the review is the only place it can be said.
   */
  | 'ends-external-delegation'
  | 'spends-unconfirmed-input'
  /**
   * A signature in this transaction was made with a nonce derived from public
   * data, so the signature reveals its own signing key. Raised only from proof
   * — its absence is never evidence that a key is safe.
   */
  | 'leaked-signing-key'

/** A vkey witness present in a witness set (Signatures view). */
export type ReviewedVkeyWitness = {
  readonly vkeyHex: string
  readonly signatureHex: string
  /**
   * blake2b-224 of the vkey — the credential this witness satisfies, and the
   * only form comparable with `requiredSigners` or an address's payment/stake
   * credential. Absent when the key could not be hashed (malformed witness);
   * every match below is then `false`/`undefined` because it is unknown, not
   * because it failed.
   */
  readonly keyHashHex?: string
  /** Whose key signed, when its hash matches the wallet context. */
  readonly owner?: OwnerKind
  /** The witness satisfies one of the body's explicit `required_signers`. */
  readonly satisfiesRequiredSigner: boolean
  /**
   * The signature provably reveals its own signing key. `false` means "not
   * proven here" — never "this key is safe" (see `leaked-signing-key`).
   */
  readonly leaksSigningKey: boolean
}

/** Script/datum surface counts for the Smart-contracts view. */
export type ScriptSummary = {
  readonly native: number
  readonly plutusV1: number
  readonly plutusV2: number
  readonly plutusV3: number
  readonly redeemers: number
  readonly datums: number
}

/** Collateral group (inputs at risk + optional return output + explicit total). */
export type ReviewedCollateral = {
  readonly inputs: readonly InputRef[]
  readonly returnOutput?: ReviewedIO
  readonly balance?: bigint
}

/**
 * Where a settled transaction sits in the chain. Every field is independently
 * optional: a producer reports what its source gave it and nothing more, so a
 * missing height is an unreported height rather than height zero.
 */
export type ReviewedBlock = {
  /** Absolute slot of the containing block. */
  readonly slot?: number
  readonly height?: number
  readonly epoch?: number
  readonly hashHex?: string
}

/** The wallet-aware review of one transaction. */
export type ReviewedTransaction = {
  readonly chain: 'cardano'
  /** Tx id — present on the history path, absent when reviewing an unsigned body. */
  readonly hash?: string
  /** ISO-8601 timestamp (history path). */
  readonly timestamp?: string
  /**
   * `failed` is the ledger's phase-2 verdict — scripts failed, collateral was
   * consumed, and the transaction is on-chain regardless. Absent means unknown,
   * which is not the same as `confirmed`: only a producer that read the verdict
   * (the transaction's own `is_valid` byte) may claim one.
   */
  readonly status?: 'pending' | 'confirmed' | 'failed'
  /** Block context, on a settled transaction whose producer had it. */
  readonly block?: ReviewedBlock
  /** network_id body field when present (0 testnet / 1 mainnet). */
  readonly networkId?: number
  readonly fee: bigint
  readonly ttl?: bigint
  readonly validityIntervalStart?: bigint
  /** Inputs the wallet could resolve (classified + valued). */
  readonly inputs: readonly ReviewedIO[]
  /** Inputs with no matching UTxO in the wallet (foreign / unknown). */
  readonly unresolvedInputs: readonly InputRef[]
  readonly outputs: readonly ReviewedIO[]
  readonly referenceInputs: readonly InputRef[]
  readonly collateral?: ReviewedCollateral
  readonly scriptDataHashHex?: string
  /** Aux-data hash (metadata); full labels/msg only when the aux body is available. */
  readonly auxiliaryDataHashHex?: string
  /**
   * The exact bytes this review decoded, for copying out — so what Details
   * offers cannot drift from what it renders. Absent only on the
   * indexed-summary path, which never sees any.
   *
   * `kind` matters to whoever pastes it elsewhere. Before signing there is no
   * signed transaction yet, so a body is all there is; once settled, the body
   * is a byte-exact slice of the full transaction and therefore strictly less
   * useful — it cannot verify a signature or be re-submitted. Producers hand
   * over the most complete form they hold.
   */
  readonly cbor?: {readonly hex: string; readonly kind: 'body' | 'transaction'}
  /** Decoded metadata labels/msg where available (else empty; hash is the durable ref). */
  readonly metadata: Record<string, unknown>
  /** Explicit required_signers (body key 14), as 28-byte key-hash hexes. */
  readonly requiredSigners: readonly string[]
  /** Vkey witnesses (present when a witness set was supplied — history/partial-sign). */
  readonly witnessSet?: readonly ReviewedVkeyWitness[]
  /**
   * Byron-era bootstrap witnesses (witness-set key 2), as a count.
   *
   * Only a count: this wallet cannot produce one, and modelling a witness shape
   * we never emit would be speculative. But the count must exist, because
   * without it a transaction carrying one reports fewer signatures than it
   * actually has — the vkey list would silently be the whole story.
   *
   * Absent when no witness set was supplied; `0` means one was and had none.
   */
  readonly bootstrapWitnesses?: number
  readonly scripts: ScriptSummary
  /**
   * Net effect on the wallet's spendable UTxOs: own outputs − own inputs. Fee is
   * NOT folded in (implicit in the input/output difference; surfaced via `fee`).
   *
   * A withdrawal is **not** added on top. Withdrawn rewards leave the reward
   * account and arrive in an output, so they are already inside the output side
   * of that difference; adding them again reported a withdrawal as roughly twice
   * what it paid. The rewards themselves are the `reward-withdrawal` operation.
   */
  readonly ownDelta: readonly ReviewedAmount[]
  /**
   * The transaction's parties, partitioned into four tiers with per-party netted
   * sent/received. Each is empty when nothing matched it — no tier is implied:
   *
   * - `ownGroup` — the signing wallet's own addresses (it can spend them).
   * - `identityGroup` — the forum identity's own addresses. The user's, but a
   *   different seed, so never folded into `ownGroup` or `ownDelta`.
   * - `escrowGroup` — script addresses delegating to one of our stake
   *   credentials; `stakeCredHex` says which.
   * - `otherGroup` — everyone else, including addresses that reuse our stake
   *   credential under a foreign payment key (see `stake-credential-reuse`).
   */
  readonly ownGroup: AddressGroup
  readonly identityGroup: AddressGroup
  readonly escrowGroup: AddressGroup
  readonly otherGroup: AddressGroup
  /** Convenience: what each external counterparty nets in (derived from otherGroup). */
  readonly counterparties: readonly {readonly address: AddressRef; readonly received: readonly ReviewedAmount[]}[]
  readonly operations: readonly ReviewedOperation[]
  readonly warnings: readonly TransactionWarning[]
}

/** One party's credential set: the payment keys it can spend with + its stake key. */
export type CredentialSet = {
  /** blake2b-224 hashes of the payment verification keys (all indexes). */
  readonly paymentKeyHashes: ReadonlySet<string>
  /**
   * Script credentials this party spends *through* — a native-script wallet's own
   * payment credentials, one per payment index.
   *
   * Separate from {@link paymentKeyHashes} because the two are not
   * interchangeable: a script credential we hold the policy for is ours, while
   * any *other* script credential over our stake key is an escrow, and only a
   * key credential can be hijacked. Absent for an ordinary wallet, where every
   * script address really does belong to someone else.
   */
  readonly paymentScriptHashes?: ReadonlySet<string>
  /**
   * Script payment credentials **shared across holders**, ours only when paired with our own stake
   * credential.
   *
   * A CIP-113 smart wallet is the deployment's programmable-logic script plus the holder's stake
   * credential, so the script alone names *everyone's* wallet. That makes it the opposite of
   * {@link paymentScriptHashes}, where membership is sufficient because a native-script wallet's
   * policy is unique to it. Listing a shared script there would claim every holder's balance as
   * this wallet's.
   *
   * Both halves must match, and the pairing is what ownership means here.
   */
  readonly sharedPaymentScriptHashes?: ReadonlySet<string>
  /** blake2b-224 hash of the stake verification key. */
  readonly stakeKeyHashHex?: string
  /**
   * {@link stakeKeyHashHex} is a *script* hash, not a key hash — a shared
   * wallet's delegation script.
   *
   * Says which kind the 28 bytes are, because the bytes themselves cannot. What
   * turns on it is whether a script-credential certificate is this wallet
   * delegating itself or a stranger's script acting on it, and those deserve
   * opposite treatment on screen.
   */
  readonly stakeIsScript?: boolean
}

/**
 * What the wallet knows about itself, as plain data (no service deps).
 *
 * The funds-wallet credentials sit at the top level (unchanged shape, so every
 * existing caller keeps working); `identity` is the forum identity's own
 * CIP-1852 pair, present only once it has been persisted at identity creation.
 * Absent identity simply means the ID tier never matches — never a guess.
 */
export type WalletContext = CredentialSet & {
  readonly identity?: CredentialSet
}

/** A wallet UTxO matching one of the tx's inputs, resolved app-side. */
export type ResolvedInput = {
  readonly txHashHex: string
  readonly index: number
  /** Raw address bytes, hex. */
  readonly addressHex: string
  /**
   * The same address in bech32, when the producer has it. Inputs are outpoints in
   * the body, so their address always comes from elsewhere (a UTxO set or an
   * indexer) — and both of those speak bech32. Without carrying it, a resolved
   * input renders as raw hex next to bech32 outputs.
   */
  readonly addressBech32?: string
  readonly coin: bigint
  readonly tokens: readonly {readonly policyIdHex: string; readonly assetNameHex: string; readonly amount: bigint}[]
  /**
   * The transaction that created this UTxO has not confirmed yet — i.e. this is a
   * *virtual* output, spendable only because we submitted its parent moments ago.
   *
   * Supplied by the app, which is the only layer that knows: the wallet's
   * spendable view merges confirmed and pending outputs deliberately, so nothing
   * downstream can tell them apart. Absent means "confirmed, or not asked".
   */
  readonly fromUnconfirmedTx?: boolean
}

/** A key the wallet can sign with: its hash + the BIP-32 path that derives it. */
export type OwnedSigningKey = {
  readonly keyHashHex: string
  /** e.g. `m/1852'/1815'/0'/0/0`. */
  readonly path: string
}
