/**
 * Protocol knowledge the model only receives when the transaction actually involves it.
 *
 * A summary of a Reeve journal entry is useless without knowing what Reeve is, and a summary of
 * anything else is *worse* for carrying that explanation. So the knowledge is presence-gated:
 * detected from the transaction, and costing nothing on the transactions it does not describe.
 * The model's context is small — `generate` rejects on overflow — so this is a budget, not a
 * dumping ground.
 *
 * ### ⚠️ Written for a beginner, in good faith
 *
 * The reader is someone trying to understand what their own transaction did. So a snippet states
 * what a protocol IS and what it means for them — a label registered to Reeve is described as
 * Reeve, not as something merely "claiming" to be.
 *
 * The earlier version hedged every sentence ("CLAIMS", "unauthenticated", "nothing verifies"),
 * which was the wrong trade twice over: the screen already carries a blanket accuracy disclaimer,
 * and this model is documented mirroring prompt register straight back at the reader — so the
 * hedging bought protection against a rare forged label at the cost of frightening every ordinary
 * user about a transaction that was fine. Dev-lead call, 2026-08-17.
 *
 * What still holds it together, none of which needs a caveat in the prose:
 *
 * - **Amounts are never in here.** Every figure the model sees is computed from the transaction's
 *   own bytes, so a mislabelled transaction still gets its money described correctly.
 * - **The payload stays untrusted.** Author-written strings go in the prompt's UNTRUSTED block
 *   with its own proportionate framing ("calls itself X"). A snippet describes the *protocol*;
 *   it never vouches for the *content*.
 * - **The title rule is unchanged.** `metadata/protocol.ts` still refuses to let a protocol name
 *   retitle a transaction that moved value — that guard lives on screen, not in this prose.
 *
 * ### What a snippet may not contain
 *
 * **Numbers.** Every figure in the prompt is computed from the transaction's own bytes; a snippet
 * is the only authored prose in it. A number here would be indistinguishable, to the model, from
 * one that came from the chain.
 *
 * @module
 */

import type {ReviewedTransaction} from '@pnyx/tx-review'

/** Packs are English data, like the warning texts — the whole model exchange is English. */
export type ContextPackId =
  | 'reeve'
  | 'reeve-obsolete'
  | 'marlowe'
  | 'nft-metadata'
  | 'governance'
  | 'catalyst'
  | 'dapp-registration'
  | 'token-registration'
  | 'multisig-registration'
  | 'oracle'
  | 'cip113-transfer'

/** Most transactions detect none; two is already a lot of context to spend. */
export const MAX_PACKS = 2

export const PACKS: Readonly<Record<ContextPackId, string>> = {
  reeve:
    'Label 1447 belongs to Reeve, a system organisations use to publish their accounting records on Cardano. This transaction carries a bookkeeping journal entry — the point of it is the record it stores, not moving money.',
  'reeve-obsolete':
    "Label 1517 is Reeve's early pre-launch record format, from before the current one. The transaction carries accounting data in that older shape.",
  marlowe:
    'Label 1564 belongs to Marlowe, a language for writing financial agreements that run on Cardano — things like escrows and instalment plans. This transaction is a step in one of those agreements.',
  'nft-metadata':
    'Label 721 is the standard way (CIP-25) a token describes itself as an NFT: its name, its image and its attributes. It is what makes a wallet or marketplace able to display the token as a collectible.',
  governance:
    "Cardano's on-chain governance lets ADA holders vote on proposals, or hand their voting power to a representative (a DRep) who votes for them. Voting power follows the stake, so it moves and locks no funds, and it is separate from delegating stake to a pool for rewards.",
  catalyst:
    'Project Catalyst is a funding programme where ADA holders vote on which proposals get grants. Registering links a wallet to a voting key so its stake counts as voting power. It moves no funds and lets nobody else spend them.',
  'dapp-registration':
    'Label 1667 is the standard (CIP-72) by which an application publishes its own details — who runs it and which scripts it uses — so wallets and stores can list it.',
  'token-registration':
    'Label 867 is the standard (CIP-88) by which a token policy publishes information about itself, such as who issued it and what the token is for.',
  'multisig-registration':
    'Label 1854 records the setup of a shared wallet: which keys are allowed to sign for it and how many of them are needed before it can spend anything.',
  oracle:
    'These labels belong to oracles — services that publish outside information, such as prices, onto the chain so that contracts and applications can read it.',
  'cip113-transfer':
    'This moves a programmable token (CIP-113). These are not held at an ordinary address: they sit in a "smart wallet", a script address tied to the holder\'s staking key, and every transfer runs rules set by whoever issued the token — which can limit who is allowed to receive it. That is why moving one runs contracts and sets aside collateral, and why the balance left over comes back to the smart wallet rather than to the ordinary address.',
}

/**
 * Which pack a metadata label earns, or `null` for "the registry name is enough".
 *
 * ⚠️ **Every label in `METADATA_LABELS` must appear here**, `null` included — the point is that
 * adding a label to the registry forces someone to decide whether it needs explaining, rather
 * than silently getting none. TypeScript cannot enforce it (the registry is keyed by `string`,
 * because that is how a label arrives off chain), so `context-packs.test.ts` does.
 *
 * `null` is the honest answer for most of them: a bridge routing label or a marketplace listing
 * tells a wallet owner nothing they need in order to understand what their money did.
 */
export const PACK_BY_LABEL: Readonly<Record<string, ContextPackId | null>> = {
  '17': null,
  '22': null,
  '87': null,
  '88': null,
  '94': 'governance',
  '123': null,
  '170': null,
  '309': null,
  '544': null,
  '620': null,
  // CIP-20 is rendered as the sender's own message, never as a protocol.
  '674': null,
  '721': 'nft-metadata',
  '777': null,
  '839': null,
  '867': 'token-registration',
  '888': null,
  '1226': 'oracle',
  '1304': null,
  '1447': 'reeve',
  '1517': 'reeve-obsolete',
  '1564': 'marlowe',
  '1667': 'dapp-registration',
  '1668': null,
  '1694': 'governance',
  '1854': 'multisig-registration',
  '1870': null,
  '1888': null,
  '1904': null,
  '1967': 'oracle',
  '1968': 'oracle',
  '1983': null,
  '1984': null,
  '1988': null,
  '1989': null,
  '3165': null,
  '3692': 'governance',
  '6607': null,
  '6676': null,
  '6770': null,
  '8413': null,
  '8414': null,
  '10297': null,
  '18300': null,
  '18308': null,
  '21325': null,
  '61284': 'catalyst',
  '61285': 'catalyst',
  '61286': 'catalyst',
}

/** Governance operations that earn the governance pack even with no metadata label. */
const GOVERNANCE_OPERATIONS = new Set([
  'vote-delegation',
  'stake-vote-delegation',
  'vote-reg-delegation',
  'stake-vote-reg-delegation',
  'drep-registration',
  'drep-deregistration',
  'drep-update',
  'voting-procedures',
  'proposal-procedures',
  'committee-hot-auth',
  'committee-cold-resign',
])

/**
 * The packs this transaction earns, in registry order, capped at {@link MAX_PACKS}.
 *
 * Detection is from the transaction itself, never from a caller's opinion of it. Labels are read
 * in ascending numeric order for the same reason `metadataProtocol` does: a transaction carrying
 * several must resolve the same way every time.
 *
 * `isCip113` is passed in rather than detected here because it needs the deployment record, which
 * is configuration and not part of the reviewed transaction.
 */
export const detectContextPacks = (
  reviewed: ReviewedTransaction,
  options: {readonly isCip113?: boolean} = {},
): readonly ContextPackId[] => {
  const found: ContextPackId[] = []
  const add = (id: ContextPackId): void => {
    if (!found.includes(id)) found.push(id)
  }

  if (options.isCip113 === true) add('cip113-transfer')

  const labels = Object.keys(reviewed.metadata)
    .filter((key) => /^\d+$/.test(key))
    .sort((a, b) => Number(a) - Number(b))
  for (const label of labels) {
    // `hasOwn`, because the label is off-chain data reaching a plain object: a bare lookup
    // answers `toString` with a function.
    const id = Object.hasOwn(PACK_BY_LABEL, label) ? PACK_BY_LABEL[label] : undefined
    if (id != null) add(id)
  }

  if (reviewed.operations.some((op) => GOVERNANCE_OPERATIONS.has(op.kind))) add('governance')

  return found.slice(0, MAX_PACKS)
}
