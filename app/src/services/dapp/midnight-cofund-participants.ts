/**
 * Which wallets an agent's co-funded call may actually spend from.
 *
 * ⚠️ **This is the authority boundary of the feature, so it is a pure function with tests** rather than
 * a few lines inside a runner that opens vaults. A wallet the person did not put in this agent's scope
 * list cannot be named as a source; getting that wrong would let an agent spend from a wallet it was
 * never granted, and it is the one rule here that no downstream refusal would catch.
 *
 * @module
 */

import type {ParsedMidnightCoFundSource} from '../mcp/build-args'
import type {CoFundParticipant} from '../midnight/multiparty/co-funded-send'

/** One wallet an agent was granted, as the Midnight builders need it. */
export type GrantedMidnightScope = {
  readonly key: string
  readonly groupId: string
  readonly accountIndex: number
  readonly name: string
}

export type ParticipantsResult =
  | {readonly ok: true; readonly participants: readonly CoFundParticipant[]}
  | {readonly ok: false; readonly message: string}

/**
 * Resolve each named source to a granted wallet, and require the composer to be one of them.
 *
 * ⚠️ **The composer must contribute.** It is the wallet the call was addressed to, and the one the
 * review persists against — a call that named it and then spent only *other* wallets' money would file
 * a pending row against a wallet with nothing in the transaction. Naming the rule lets an agent address
 * the call elsewhere instead of guessing.
 *
 * A refusal names the granted keys, because "not granted" with no list invites a retry loop.
 */
export const resolveCoFundParticipants = (
  sources: readonly ParsedMidnightCoFundSource[],
  granted: ReadonlyMap<string, GrantedMidnightScope>,
  composerKey: string,
): ParticipantsResult => {
  const participants: CoFundParticipant[] = []
  for (const source of sources) {
    const scope = granted.get(source.scope)
    if (scope === undefined) {
      return {
        ok: false,
        message:
          `\`sources\` names the scope '${source.scope}', which this wallet has not granted. ` +
          `Granted: ${[...granted.keys()].join(', ')}.`,
      }
    }
    participants.push({
      groupId: scope.groupId,
      accountIndex: scope.accountIndex,
      scopeKey: scope.key,
      name: scope.name,
      pledge: source.pledge,
    })
  }
  if (!participants.some((participant) => participant.scopeKey === composerKey)) {
    return {
      ok: false,
      message:
        `\`sources\` must include the wallet this call is addressed to ('${composerKey}') — it is the ` +
        'one composing the transaction, so it has to be one of the contributors. Address the call to a ' +
        'different scope to compose from that wallet instead.',
    }
  }
  return {ok: true, participants}
}
