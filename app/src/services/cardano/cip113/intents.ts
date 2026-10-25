/**
 * Turning the send screen's recipients into CIP-113 transfer intents.
 *
 * Pure, and in its own module, because the bug it exists to prevent lived in a React callback where
 * nothing could reach it: the programmable path read `state.targets[0]` and gave that one recipient
 * the whole basket. A send to two people built a *valid* transaction that paid one of them and
 * returned the rest as change — no error, and a review that honestly described the wrong thing.
 *
 * @module
 */

import type {ProgrammableRecipient} from './recipient'
import type {TransferIntent} from './transfer-plan'

/** What the send screen knows about one recipient: what was typed, and their own allocation. */
export type IntentTarget = {
  readonly address: string
  /** assetId (`policy.name`) → quantity for *this* recipient. Never the basket total. */
  readonly amounts: ReadonlyMap<string, bigint>
}

export type IntentBuild =
  | {readonly kind: 'ok'; readonly intents: readonly TransferIntent[]}
  /** One recipient cannot hold a programmable token. Carries which, since "that address" does not say. */
  | {readonly kind: 'refused'; readonly address: string; readonly detail: string}
  /** Recipients exist but nothing is allocated to any of them. */
  | {readonly kind: 'empty'}

/**
 * One intent per (recipient, asset) with a positive allocation.
 *
 * ⚠️ Every target, and each one's **own** `amounts`. The basket is a total across the whole send;
 * reading it per recipient would promise each of them the entire amount.
 *
 * A single unusable recipient refuses the whole build rather than being dropped from it. Sending to
 * three of the four people asked for, silently, is the failure mode this module is named after.
 */
export const programmableIntents = (
  targets: readonly IntentTarget[],
  assetIds: readonly string[],
  resolve: (address: string) => ProgrammableRecipient,
): IntentBuild => {
  const intents: TransferIntent[] = []
  for (const target of targets) {
    const recipient = resolve(target.address)
    if (recipient.kind === 'refused') return {kind: 'refused', address: target.address, detail: recipient.detail}
    for (const id of assetIds) {
      const [policyHex = '', assetNameHex = ''] = id.split('.')
      const quantity = target.amounts.get(id) ?? 0n
      if (quantity > 0n) intents.push({policyHex, assetNameHex, quantity, recipient: recipient.owner})
    }
  }
  return intents.length === 0 ? {kind: 'empty'} : {kind: 'ok', intents}
}
