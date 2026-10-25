/**
 * Pure merge rule for {@link DerivedGroupAddresses}.
 *
 * `derivedGroupAddresses` is updated from two paths:
 *  - The group-switch effect that resets the Map and fans out derivations.
 *  - `enableChainForGroup` (and any future chain-add path), which mutates
 *    `group.wallets` *without* changing the groupId.
 *
 * Both paths must reject stale writes whose target groupId no longer matches
 * the current active group. Extracting the merge keeps that guard in one
 * place and unit-testable, avoiding a regression where one writer skips it.
 *
 * @module
 */
import type {ChainId} from '@pnyx/config'

export type DerivedGroupAddresses = {
  readonly groupId: string | null
  readonly addresses: ReadonlyMap<ChainId, string>
}

export function mergeChainAddress(
  prev: DerivedGroupAddresses,
  groupId: string,
  chainId: ChainId,
  address: string,
): DerivedGroupAddresses {
  if (prev.groupId !== groupId) return prev
  const next = new Map(prev.addresses)
  next.set(chainId, address)
  return {groupId, addresses: next}
}
