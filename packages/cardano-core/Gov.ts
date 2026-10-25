/**
 * Conway on-chain governance: voting procedures (body key 19) and proposal procedures (key 20).
 *
 * A thin tier like the others — the codec owns the bytes, this owns the shapes a caller thinks in.
 * `updateCommittee` is the one that earns its place: the codec takes six parallel arrays, and
 * assembling them by hand is where a removed member ends up in the added list.
 *
 * @since 0.1.0
 */

import {
  Anchor,
  Bytes,
  DRep,
  GovernanceAction,
  KeyHash,
  ScriptHash,
  TransactionHash,
  Url,
  VotingProcedures,
} from '@evolution-sdk/evolution'
import type {TxHashHex} from '@evolution-sdk/review/Brands'
import {op} from './Op.js'

/** ⚠️ This tier encodes "no anchor" as an EMPTY URL; Evolution models it as `null`. */
const anchorOrNull = (url: string, hashHex: string) =>
  url === '' ? null : new Anchor.Anchor({anchorUrl: new Url.Url({href: url}), anchorDataHash: Bytes.fromHex(hashHex)})

/**
 * A vote, as the ledger encodes it.
 *
 * @since 0.1.0
 */
export enum Vote {
  No = 0,
  Yes = 1,
  Abstain = 2,
}

/**
 * A DRep voter.
 *
 * @since 0.1.0
 * @category voters
 */
export const voterDrep = (hashHex: string, isScript = false) =>
  op('voterDrep', () =>
    VotingProcedures.voterToCBORHex(
      new VotingProcedures.DRepVoter({
        drep: isScript ? DRep.fromScriptHash(ScriptHash.fromHex(hashHex)) : DRep.fromKeyHash(KeyHash.fromHex(hashHex)),
      }),
    ),
  )

/**
 * `gov_action_id = [ tx_id, index ]`.
 *
 * @since 0.1.0
 * @category actions
 */
export const govActionId = (txIdHex: TxHashHex, index: bigint) =>
  op('govActionId', () =>
    GovernanceAction.govActionIdToCBORHex(
      new GovernanceAction.GovActionId({transactionId: TransactionHash.fromHex(txIdHex), govActionIndex: index}),
    ),
  )

/**
 * `voting_procedure = [ vote, anchor/null ]`. An empty `anchorUrl` means no anchor.
 *
 * @since 0.1.0
 * @category voting
 */
export const votingProcedure = (vote: Vote, anchorUrl = '', anchorHashHex = '') =>
  op('votingProcedure', () => {
    // Refused rather than defaulted: there is no safe default for how someone voted.
    const cast =
      vote === Vote.No
        ? VotingProcedures.no()
        : vote === Vote.Yes
          ? VotingProcedures.yes()
          : vote === Vote.Abstain
            ? VotingProcedures.abstain()
            : undefined
    if (cast === undefined) throw new Error(`voting_procedure: unknown vote ${String(vote)}`)
    return VotingProcedures.votingProcedureToCBORHex(
      new VotingProcedures.VotingProcedure({vote: cast, anchor: anchorOrNull(anchorUrl, anchorHashHex)}),
    )
  })

/**
 * The `voting_procedures` map, from parallel (voter, gov_action_id, voting_procedure) hexes.
 *
 * @since 0.1.0
 * @category voting
 */
export const votingProcedures = (
  voterHexes: ReadonlyArray<string>,
  gaidHexes: ReadonlyArray<string>,
  vpHexes: ReadonlyArray<string>,
) =>
  op('votingProcedures', () => {
    // ⚠️ Grouped by voter in FIRST-SEEN order, and the key is looked up by its ENCODED bytes:
    // two decodes of the same voter are different objects, so a `Map` keyed on identity would
    // split one voter's votes across two entries and emit a procedures map the ledger reads as
    // two voters.
    const procedures = new Map<
      VotingProcedures.Voter,
      Map<GovernanceAction.GovActionId, VotingProcedures.VotingProcedure>
    >()
    voterHexes.forEach((voterHex, i) => {
      const existing = [...procedures.keys()].find((k) => VotingProcedures.voterToCBORHex(k) === voterHex)
      const key = existing ?? VotingProcedures.voterFromCBORHex(voterHex)
      const gaid = gaidHexes[i]
      const vp = vpHexes[i]
      if (gaid === undefined) throw new Error(`voting_procedures: voter ${i} has no gov action id`)
      if (vp === undefined) throw new Error(`voting_procedures: voter ${i} has no voting procedure`)
      const votes = procedures.get(key) ?? new Map()
      votes.set(GovernanceAction.govActionIdFromCBORHex(gaid), VotingProcedures.votingProcedureFromCBORHex(vp))
      procedures.set(key, votes)
    })
    return VotingProcedures.toCBORHex(new VotingProcedures.VotingProcedures({procedures}))
  })
